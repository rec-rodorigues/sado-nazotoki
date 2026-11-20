// =========================================
// 謎解きサイト本体
// =========================================
(function() {
    const api = window.NazoApi;
    const $ = function(id) { return document.getElementById(id); };

    const GROUPS = [
        { key: "act1", label: "第一幕" },
        { key: "act2", label: "第二幕" },
        { key: "act3", label: "第三幕" },
        { key: "act4", label: "第四幕" }
    ];

    let session = null;     // { team, code }
    let state = null;
    let currentGroup = null;
    let loadedGroup = null;
    let seenGroups = [];
    let knownPoints = new Set();

    // ---------- お知らせ ----------
    function notify(text, isError) {
        const el = document.createElement("div");
        el.className = "toast" + (isError ? " error" : "");
        el.textContent = text;
        $("toastArea").appendChild(el);
        setTimeout(function() { el.remove(); }, 3500);
    }

    function store(key, value) {
        try {
            if (value === undefined) return JSON.parse(localStorage.getItem(key));
            localStorage.setItem(key, JSON.stringify(value));
        } catch (e) {
            return null;
        }
    }

    // ---------- 画面切り替え ----------
    function showView(id) {
        document.querySelectorAll(".view").forEach(function(v) { v.classList.toggle("active", v.id === id); });
        document.querySelectorAll("#tabbar button").forEach(function(b) { b.classList.toggle("active", b.dataset.view === id); });
        $("composer").hidden = id !== "chatView";
        if (id === "mapView") {
            setTimeout(function() { map.invalidateSize(); }, 50);
        }
        if (id === "chatView") scrollChat();
        if (session) store("nazo-view", id);
    }

    document.querySelectorAll("#tabbar button").forEach(function(b) {
        b.addEventListener("click", function() { showView(b.dataset.view); });
    });

    // ---------- 地図（佐渡島マップと同じ見た目） ----------
    const map = L.map("map", { zoomControl: true }).setView([38.02, 138.37], 10);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; <a href=\"https://www.openstreetmap.org/copyright\">OpenStreetMap</a> contributors",
        maxZoom: 19
    }).addTo(map);

    const tokiLayer = L.layerGroup().addTo(map);
    const spotLayer = L.layerGroup().addTo(map);
    let tempMarker = null;

    const categoryStyles = {
        "活動場所": { color: "#B33A2B", mark: "活" },
        "宿泊地": { color: "#2B2622", mark: "宿" },
        "観光地": { color: "#A5822F", mark: "観" },
        "飲食店": { color: "#5B7C4F", mark: "食" },
        "生活用品店": { color: "#3E5C76", mark: "買" }
    };

    function pinIcon(color, inner, extra) {
        const big = extra === "pin-treasure";
        return L.divIcon({
            html: "<div class=\"pin " + (extra || "") + "\" style=\"--pin-color:" + color + "\">" + inner + "</div>",
            className: "pin-marker",
            iconSize: big ? [40, 40] : [32, 32],
            iconAnchor: big ? [20, 48] : [16, 39],
            popupAnchor: [0, -36]
        });
    }

    function escapeHtml(v) {
        return String(v == null ? "" : v).replace(/[&<>"']/g, function(c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c];
        });
    }

    function drawPoints(fresh) {
        tokiLayer.clearLayers();
        const pts = state.points;
        pts.forEach(function(p) {
            const isNew = fresh && !knownPoints.has(p[0]);
            L.marker([p[1], p[2]], {
                icon: L.divIcon({ className: "", html: "<div class=\"toki-dot" + (isNew ? " new" : "") + "\"></div>", iconSize: [12, 12], iconAnchor: [6, 6] }),
                keyboard: false,
                interactive: false
            }).addTo(tokiLayer);
        });
        // 全部そろったら、点を順につないでトキの絵にする
        if (pts.length === state.total_points && pts.length > 0) {
            // くちばし：先(0)→下くちばし(1)→3…59→上くちばし(2)→先(0) の順につなぐ
            const byId = {};
            pts.forEach(function(p) { byId[p[0]] = [p[1], p[2]]; });
            const order = [0, 1];
            for (let i = 3; i < state.total_points; i++) order.push(i);
            order.push(2, 0);
            const line = order.map(function(i) { return byId[i]; }).filter(Boolean);
            L.polyline(line, { color: "#B33A2B", weight: 3, opacity: 0.8 }).addTo(tokiLayer);
        }
        knownPoints = new Set(pts.map(function(p) { return p[0]; }));
    }

    // 掘った跡と、見つけた宝箱の印
    function drawSpots() {
        spotLayer.clearLayers();
        (state.dug || []).forEach(function(d) {
            L.marker([d[0], d[1]], { icon: pinIcon("#8C8273", "<i class=\"ti ti-x\"></i>", "pin-dug"), interactive: false, keyboard: false })
                .addTo(spotLayer);
        });
        if (state.found) {
            L.marker(state.found, { icon: pinIcon("#A5822F", "<i class=\"ti ti-treasure-chest\"></i>", "pin-treasure") })
                .on("click", function() { showChest(); })
                .addTo(spotLayer);
        }
    }

    // ---------- 宝箱を探す ----------
    let searchMode = false;
    const SHOVEL = $("searchButton").querySelector(".shovel").outerHTML;

    function renderDurability(el) {
        const left = state.shovels - state.used;
        let html = "<span>耐久力</span>";
        for (let i = 0; i < state.shovels; i++) html += "<span class=\"pip" + (i < left ? "" : " used") + "\"></span>";
        el.innerHTML = html;
    }

    function setSearchMode(on) {
        searchMode = on;
        $("searchButton").classList.toggle("on", on);
        $("map").classList.toggle("adding", on);
        renderSearchBar();
        if (!on && tempMarker) { tempMarker.remove(); tempMarker = null; }
    }

    function renderSearchBar() {
        const btn = $("searchButton");
        const broken = state.used >= state.shovels && !state.found;
        renderDurability($("durability"));
        $("durability").hidden = !!state.found;
        btn.classList.toggle("broken", broken);
        if (state.found) {
            $("searchLabel").textContent = "宝箱を開ける";
            $("mapHint").textContent = "";
        } else if (broken) {
            $("searchLabel").textContent = "スコップが折れた";
            $("mapHint").textContent = "運営を呼んでください。";
        } else if (searchMode) {
            $("searchLabel").textContent = "探すのをやめる";
            $("mapHint").textContent = "宝箱がありそうな場所をタップしよう。";
        } else {
            $("searchLabel").textContent = "宝箱を探す";
            $("mapHint").textContent = "";
        }
    }

    $("searchButton").addEventListener("click", function() {
        if (state.found) { showChest(); return; }
        if (state.used >= state.shovels) { showDigResult("broken"); return; }
        setSearchMode(!searchMode);
    });

    let pendingLatLng = null;

    map.on("click", function(e) {
        if (!searchMode) return;
        pendingLatLng = e.latlng;
        if (tempMarker) tempMarker.remove();
        tempMarker = L.marker(e.latlng, { icon: pinIcon("#FFFCF6", "<i class=\"ti ti-search\"></i>", "pin-temp") }).addTo(map);
        $("digLatLng").textContent = "緯度 " + e.latlng.lat.toFixed(4) + " ／ 経度 " + e.latlng.lng.toFixed(4);
        $("digLeft").textContent = "スコップの耐久力：のこり " + (state.shovels - state.used) + " 回";
        $("digAsk").hidden = false;
        $("digResult").hidden = true;
        $("digSheet").classList.add("open");
    });

    function closeDigSheet() {
        $("digSheet").classList.remove("open");
        if (tempMarker) { tempMarker.remove(); tempMarker = null; }
    }

    $("digCancel").addEventListener("click", closeDigSheet);
    $("digClose").addEventListener("click", closeDigSheet);

    function showDigResult(kind, left) {
        $("digAsk").hidden = true;
        $("digResult").hidden = false;
        $("staffBox").hidden = kind !== "broken";
        $("staffError").textContent = "";
        $("staffPassword").value = "";
        const msg = $("digMsg");
        msg.className = "dig-msg";
        if (kind === "nothing") {
            msg.textContent = "何も見つからなかった…\nスコップの耐久力が下がった…\n（のこり " + left + " 回）";
        } else if (kind === "broken") {
            msg.textContent = "何も見つからなかった…\nスコップが折れてしまった…\n運営を呼んでください。";
        }
        renderDurability($("digDurability"));
        $("digSheet").classList.add("open");
        // 掘る動きをやり直す
        const anim = $("digAnim");
        anim.innerHTML = SHOVEL;
    }

    $("digGo").addEventListener("click", async function() {
        if (!pendingLatLng) return;
        $("digGo").disabled = true;
        try {
            const res = await api.search(session.team, pendingLatLng.lat, pendingLatLng.lng);
            await refresh(false);
            if (res.status === "found") {
                closeDigSheet();
                setSearchMode(false);
                addMsg("bot", "スコップの先に、何か硬いものが当たった…！\n宝箱だ！", "ok");
                showChest();
                return;
            }
            showDigResult(res.status, res.left);
            if (res.status === "broken") setSearchMode(false);
        } catch (err) {
            notify(err.message, true);
        } finally {
            $("digGo").disabled = false;
        }
    });

    $("staffGo").addEventListener("click", async function() {
        if (await api.refill(session.team, $("staffPassword").value)) {
            await refresh(false);
            closeDigSheet();
            notify("スコップを直しました。耐久力が元に戻りました。");
        } else {
            $("staffError").textContent = "パスワードがちがいます。";
        }
    });

    // ---------- 宝箱：見つけた → 開かない → 合言葉で開く ----------
    function showChest() {
        const f = $("finale");
        f.classList.remove("opened", "locked", "rattle");
        $("coins").innerHTML = "";
        $("lockError").textContent = "";
        if (state.cleared) {
            showFinale();
            return;
        }
        f.classList.add("open");
    }

    function showFinale() {
        const f = $("finale");
        f.classList.remove("locked", "rattle");
        const t = state && state.cleared ? new Date(state.cleared) : new Date();
        $("finaleTeam").textContent = (state ? state.team.name : "") + " ・ " +
            t.getHours() + "時" + String(t.getMinutes()).padStart(2, "0") + "分に開けた";
        f.classList.add("open");
        burst();
    }

    function tapChest() {
        const f = $("finale");
        if (f.classList.contains("opened")) return;
        // 合言葉なしでは開かない
        f.classList.remove("rattle");
        void f.offsetWidth;
        f.classList.add("locked", "rattle");
        if (navigator.vibrate) { try { navigator.vibrate([30, 30, 30]); } catch (e) { /* なにもしない */ } }
        setTimeout(function() { f.classList.remove("rattle"); }, 520);
        if (!lockedOnce) {
            lockedOnce = true;
            addMsg("bot", "宝箱には錠がかかっていて、開かない…\n合言葉が必要みたい。書類の中に手がかりがあるかも。", "ng");
        }
    }

    let lockedOnce = false;

    $("lockForm").addEventListener("submit", async function(e) {
        e.preventDefault();
        const pw = $("lockInput").value.trim();
        if (!pw) return;
        const res = await api.open(session.team, pw);
        if (res.status === "opened") {
            $("lockInput").value = "";
            await refresh(false);
            addMsg("bot", "合言葉を唱えると、錠がはずれた！", "ok");
            showFinale();
        } else {
            $("lockError").textContent = "……何も起こらない。合言葉がちがうようだ。";
            const f = $("finale");
            f.classList.remove("rattle"); void f.offsetWidth; f.classList.add("rattle");
            setTimeout(function() { f.classList.remove("rattle"); }, 520);
        }
    });

    $("lockDocs").addEventListener("click", function() {
        $("finale").classList.remove("open");
        showView("docView");
        if (state.pages.act4) openGroup("act4");
    });

    $("lockClose").addEventListener("click", function() {
        $("finale").classList.remove("open");
        showView("mapView");
    });

    function burst() {
        const f = $("finale");
        if (f.classList.contains("opened")) return;
        f.classList.add("opened");
        if (navigator.vibrate) { try { navigator.vibrate([60, 40, 120]); } catch (e) { /* なにもしない */ } }
        const box = $("coins");
        for (let i = 0; i < 70; i++) {
            const c = document.createElement("span");
            c.className = "coin" + (i % 4 === 0 ? " petal" : "");
            const ang = Math.random() * Math.PI * 2;
            const dist = 25 + Math.random() * 40;
            c.style.setProperty("--x", (Math.cos(ang) * dist).toFixed(1) + "vmin");
            c.style.setProperty("--y", (Math.sin(ang) * dist - 25).toFixed(1) + "vmin");
            c.style.setProperty("--r", (Math.random() * 720 - 360).toFixed(0) + "deg");
            c.style.setProperty("--s", (8 + Math.random() * 12).toFixed(0) + "px");
            c.style.setProperty("--d", (0.35 + Math.random() * 0.5).toFixed(2) + "s");
            c.style.setProperty("--t", (2 + Math.random() * 1.6).toFixed(2) + "s");
            box.appendChild(c);
        }
    }

    $("chest").addEventListener("click", tapChest);
    $("chest").addEventListener("keydown", function(e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); tapChest(); }
    });

    $("finaleClose").addEventListener("click", function() {
        $("finale").classList.remove("open");
        showView("mapView");
        if (state.found) map.setView(state.found, 13);
    });

    // ---------- 書類 ----------
    function renderDocTabs() {
        const open = GROUPS.filter(function(g) { return state.pages && state.pages[g.key]; });
        const tabs = $("docTabs");
        tabs.innerHTML = "";
        open.forEach(function(g) {
            const b = document.createElement("button");
            b.type = "button";
            b.className = "chip" + (g.key === currentGroup ? " active" : "");
            b.setAttribute("role", "tab");
            b.textContent = g.label;
            b.addEventListener("click", function() { openGroup(g.key); });
            tabs.appendChild(b);
        });
        if (!currentGroup || !state.pages[currentGroup]) {
            openGroup(open[0].key);
        }
    }

    function openGroup(key) {
        currentGroup = key;
        if (seenGroups.indexOf(key) < 0) {
            seenGroups.push(key);
            store("nazo-seen-" + session.team, seenGroups);
        }
        if (loadedGroup !== key) {
            loadedGroup = key;
            $("docFrame").style.height = "400px";
            api.page(key).then(function(html) {
                if (loadedGroup === key) $("docFrame").srcdoc = html;
            }).catch(function(err) {
                loadedGroup = null;
                $("docError").hidden = false;
                notify(err.message, true);
            });
        }
        renderDocTabs();
    }

    // 書類ページの高さに合わせる
    window.addEventListener("message", function(e) {
        if (e.data && e.data.nazoHeight) {
            $("docFrame").style.height = (e.data.nazoHeight + 8) + "px";
        }
    });

    // 正解した書類に「正解」の印をつける
    function stampDocs() {
        let doc;
        try { doc = $("docFrame").contentDocument; } catch (e) { return; }
        if (!doc || !state) return;
        if (!doc.getElementById("nazo-stamp-style")) {
            const st = doc.createElement("style");
            st.id = "nazo-stamp-style";
            st.textContent = ".nazo-solved{position:relative}.nazo-solved::after{content:\"正解\";position:absolute;top:14px;right:14px;" +
                "border:3px solid #B33A2B;color:#B33A2B;font-weight:900;font-size:18px;padding:2px 10px;border-radius:6px;transform:rotate(-8deg);" +
                "background:rgba(255,252,246,.85);letter-spacing:.2em}";
            doc.head.appendChild(st);
        }
        doc.querySelectorAll("section.sheet").forEach(function(sec) {
            const idEl = sec.querySelector(".sheet-id");
            if (!idEl) return;
            const id = puzzleIdFromLabel(idEl.textContent);
            sec.classList.toggle("nazo-solved", !!id && state.solved.indexOf(id) >= 0);
        });
    }

    function puzzleIdFromLabel(label) {
        let m = label.match(/書類\s*([1-4]-[A-Z])/);
        if (m) return m[1];
        m = label.match(/第(一|二|三)幕\s*最終謎/);
        if (m) return { "一": "1", "二": "2", "三": "3" }[m[1]] + "-final";
        return null;
    }

    // 書類が読み込めなかったとき（古い画面が残っているときなど）
    $("docFrame").addEventListener("load", function() {
        let doc = null;
        try { doc = $("docFrame").contentDocument; } catch (e) { doc = null; }
        if (doc && !doc.querySelector(".wrap")) {
            $("docError").hidden = false;
            return;
        }
        $("docError").hidden = true;
        stampDocs();
    });

    // ---------- 回答（チャット） ----------
    let chatLog = [];

    function puzzleLabel(id) {
        if (id.endsWith("final")) return "第" + "一二三"[Number(id[0]) - 1] + "幕 最終謎";
        return "書類 " + id;
    }

    function addMsg(who, text, kind, tag, save) {
        const row = document.createElement("div");
        row.className = "msg " + who;
        const bubble = document.createElement("div");
        bubble.className = "bubble" + (kind ? " " + kind : "");
        if (tag) {
            const t = document.createElement("span");
            t.className = "tag";
            t.textContent = tag;
            bubble.appendChild(t);
        }
        bubble.appendChild(document.createTextNode(text));
        if (who === "bot") {
            const av = document.createElement("div");
            av.className = "avatar";
            av.innerHTML = "<i class=\"ti ti-mail\"></i>";
            row.appendChild(av);
        }
        row.appendChild(bubble);
        $("chat").appendChild(row);
        if (save !== false) {
            chatLog.push([who, text, kind || "", tag || ""]);
            store("nazo-chat-" + session.team, chatLog.slice(-200));
        }
        scrollChat();
    }

    function scrollChat() {
        window.scrollTo(0, document.body.scrollHeight);
    }

    function renderPuzzleSelect() {
        const sel = $("puzzleSelect");
        const keep = sel.value;
        sel.innerHTML = "";
        const open = state.puzzles.filter(function(p) {
            const g = "act" + p.act;
            return state.solved.indexOf(p.id) < 0;
        });
        open.forEach(function(p) {
            const o = document.createElement("option");
            o.value = p.id;
            o.textContent = p.kind === "final" ? p.act + " 最終" : p.id;
            sel.appendChild(o);
        });
        if (open.length === 0) {
            const o = document.createElement("option");
            o.textContent = "なし";
            o.value = "";
            sel.appendChild(o);
        }
        if (open.some(function(p) { return p.id === keep; })) sel.value = keep;
    }

    $("answerForm").addEventListener("submit", async function(e) {
        e.preventDefault();
        const pid = $("puzzleSelect").value;
        const answer = $("answerInput").value.trim();
        if (!pid || !answer) return;
        addMsg("me", answer, "", puzzleLabel(pid));
        $("answerInput").value = "";
        try {
            const before = state;
            const res = await api.answer(session.team, session.code, pid, answer);
            if (res.status === "correct") {
                state = res.state;
                let text = "正解！ " + puzzleLabel(pid) + " の答えは「" + answer + "」。";
                if (res.new_points > 0) text += "\n宝箱のありかに一歩近づいたよ。";
                if (state.searchUnlocked && !before.searchUnlocked) {
                    text += "\n…足もとに、一本のスコップが転がっていた。\n地図を開いて、宝箱を探してみよう。";
                }
                addMsg("bot", text, "ok");
                applyState(true);
            } else if (res.status === "wrong") {
                addMsg("bot", "うーん、ちがうみたい。もう一度考えてみて。", "ng");
            } else if (res.status === "already") {
                addMsg("bot", "それはもう正解しているよ。", "ng");
                await refresh(false);
            } else {
                addMsg("bot", "その書類は見つからないよ。", "ng");
            }
        } catch (err) {
            addMsg("bot", "送れなかった…（" + err.message + "）", "ng", "", false);
        }
    });

    // ---------- 状態の反映 ----------
    function applyState(fresh) {
        $("progressNote").textContent = "解いた書類 " + state.solved.length + " / " + state.puzzles.length;
        drawPoints(fresh);
        // 第三幕をすべて解くと、地図に「宝箱を探す」が現れる
        const wasHidden = $("mapBar").hidden;
        $("mapBar").hidden = !state.searchUnlocked;
        if (wasHidden && state.searchUnlocked && fresh) {
            $("searchButton").classList.add("appear");
        }
        renderSearchBar();
        drawSpots();
        renderDocTabs();
        renderPuzzleSelect();
        stampDocs();
    }

    async function refresh(fresh) {
        state = await api.state(session.team, session.code);
        applyState(fresh);
    }

    // ---------- ログイン ----------
    async function start(team, code) {
        session = { team: team, code: code };
        await refresh(false);
        store("nazo-session", session);
        seenGroups = store("nazo-seen-" + team) || [];
        chatLog = store("nazo-chat-" + team) || [];
        $("chat").innerHTML = "";
        if (chatLog.length === 0) {
            addMsg("bot", "ようこそ、" + state.team.name + "。\n書類の答えがわかったら、ここで書類の番号を選んで答えを書いてね。\n書類は第一幕から第四幕まで、全部そろっているよ。");
        } else {
            chatLog.forEach(function(m) { addMsg(m[0], m[1], m[2], m[3], false); });
        }
        $("teamBadge").textContent = state.team.name;
        $("teamBadge").hidden = false;
        $("tabbar").hidden = false;
        applyState(false);
        showView(store("nazo-view") || "docView");
    }

    function renderStartField() {
        $("startField").hidden = api.started();
    }

    $("loginButton").addEventListener("click", async function() {
        const team = Number($("teamSelect").value);
        const code = "";
        $("loginError").textContent = "";
        try {
            // 当日、運営から伝えられる「開始の合言葉」がないと始められない
            if (!api.started()) {
                const ok = await api.start($("startInput").value);
                if (!ok) {
                    $("loginError").textContent = $("startInput").value.trim()
                        ? "開始の合言葉がちがいます。"
                        : "当日、運営から伝えられる「開始の合言葉」を入れてください。";
                    return;
                }
            }
            await start(team, code);
        } catch (err) {
            session = null;
            $("loginError").textContent = err.message;
        }
    });

    $("resetButton").addEventListener("click", function() {
        const team = Number($("teamSelect").value);
        const tname = $("teamSelect").selectedOptions[0] ? $("teamSelect").selectedOptions[0].textContent : "このチーム";
        if (!confirm(tname + "の、この端末の進み具合をすべて消します。よいですか？")) return;
        api.reset(team);
        store("nazo-chat-" + team, []);
        store("nazo-seen-" + team, []);
        notify(tname + "の進み具合を消しました。");
    });

    $("teamBadge").addEventListener("click", function() {
        if (!confirm("チームを選び直しますか？（進み具合はこの端末に残ります）")) return;
        store("nazo-session", null);
        location.reload();
    });

    async function boot() {
        try {
            const teams = await api.listTeams();
            $("teamSelect").innerHTML = teams.map(function(t) {
                return "<option value=\"" + t.id + "\">" + escapeHtml(t.name) + "</option>";
            }).join("");
        } catch (err) {
            $("loginError").textContent = "チームの一覧を読み込めませんでした（" + err.message + "）";
        }
        const saved = store("nazo-session");
        if (saved && saved.team) {
            try {
                await start(saved.team, saved.code);
                return;
            } catch (err) {
                store("nazo-session", null);
            }
        }
        renderStartField();
        showView("loginView");
    }

    boot();
})();
