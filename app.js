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
    let spots = [];
    let currentGroup = null;
    let seenGroups = [];
    let knownPoints = new Set();
    let addMode = false;
    let pendingLatLng = null;

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
        if (id === "docView") $("dotDoc").classList.remove("show");
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
            // 最後の点から最初の点（くちばしの先）まで閉じてつなぐ
            const line = pts.map(function(p) { return [p[1], p[2]]; });
            line.push(line[0]);
            L.polyline(line, { color: "#B33A2B", weight: 3, opacity: 0.8 }).addTo(tokiLayer);
        }
        knownPoints = new Set(pts.map(function(p) { return p[0]; }));
    }

    function drawSpots() {
        spotLayer.clearLayers();
        spots.forEach(function(s) {
            const st = categoryStyles[s.category] || { color: "#6F665B", mark: "" };
            const icon = s.is_treasure
                ? pinIcon("#A5822F", "<i class=\"ti ti-treasure-chest\"></i>", "pin-treasure")
                : pinIcon(st.color, st.mark ? "<span class=\"pin-mark\">" + st.mark + "</span>" : "<i class=\"ti ti-map-pin\"></i>");
            L.marker([s.lat, s.lng], { icon: icon })
                .bindPopup("<b>" + escapeHtml(s.name) + "</b><br><span class=\"small-note\">" + escapeHtml(s.category || "") +
                    (s.is_treasure ? "・宝箱" : "") + "</span>" + (s.note ? "<br>" + escapeHtml(s.note) : ""))
                .addTo(spotLayer);
        });
    }

    function setAddMode(on) {
        addMode = on;
        $("addModeButton").classList.toggle("on", on);
        $("addModeButton").innerHTML = on ? "<i class=\"ti ti-x\"></i>追加をやめる" : "<i class=\"ti ti-map-pin-plus\"></i>地点追加";
        $("map").classList.toggle("adding", on);
        $("mapHint").innerHTML = on
            ? "<i class=\"ti ti-hand-click\"></i> 地図をタップすると、その場所にスポットを追加できます。"
            : "";
        if (!on && tempMarker) { tempMarker.remove(); tempMarker = null; }
    }

    $("addModeButton").addEventListener("click", function() { setAddMode(!addMode); });

    let pendingTreasureArea = false;

    map.on("click", async function(e) {
        if (!addMode) return;
        pendingLatLng = e.latlng;
        // 宝箱があるエリアのときだけ、合言葉の欄と「宝箱のありか」を出す
        pendingTreasureArea = await api.inTreasureArea(session.team, e.latlng.lat, e.latlng.lng);
        // 宝箱のありかで初めて合言葉を聞かれたら、第四幕の書類が届く
        if (pendingTreasureArea && api.markAsked(session.team)) {
            await refresh(false);
            addMsg("bot", "合言葉…？\n書類の束に、見覚えのない一枚がまぎれていた。書類タブを見てみよう。", "ok");
            notify("新しい書類「第四幕」が届いた。");
        }
        $("passwordField").hidden = !pendingTreasureArea;
        const opt = $("spotCategory").querySelector("option[data-treasure]");
        if (pendingTreasureArea && !opt) {
            const o = document.createElement("option");
            o.textContent = "宝箱のありか";
            o.dataset.treasure = "1";
            $("spotCategory").appendChild(o);
        } else if (!pendingTreasureArea && opt) {
            opt.remove();
        }
        if (tempMarker) tempMarker.remove();
        tempMarker = L.marker(e.latlng, { icon: pinIcon("#FFFCF6", "<i class=\"ti ti-plus\"></i>", "pin-temp") }).addTo(map);
        $("spotLatLng").textContent = "緯度 " + e.latlng.lat.toFixed(5) + " ／ 経度 " + e.latlng.lng.toFixed(5);
        $("spotError").textContent = "";
        $("spotSheet").classList.add("open");
        setTimeout(function() { $("spotName").focus(); }, 50);
    });

    function closeSpotSheet() {
        $("spotSheet").classList.remove("open");
    }

    $("spotCancel").addEventListener("click", closeSpotSheet);

    $("spotForm").addEventListener("submit", async function(e) {
        e.preventDefault();
        if (!pendingLatLng) return;
        const password = pendingTreasureArea ? $("spotPassword").value.trim() : "";
        if (pendingTreasureArea && !password) {
            $("spotError").textContent = "合言葉を入れてください。";
            return;
        }
        $("spotSubmit").disabled = true;
        try {
            const res = await api.addSpot(session.team, session.code, {
                name: $("spotName").value.trim(), category: $("spotCategory").value, note: $("spotNote").value.trim(),
                lat: pendingLatLng.lat, lng: pendingLatLng.lng, password: password
            });
            if (res.status === "bad_password") {
                $("spotError").textContent = "合言葉がちがうため、登録できませんでした。";
                return;
            }
            closeSpotSheet();
            setAddMode(false);
            $("spotForm").reset();
            await refresh(false);
            if (res.status === "treasure") {
                showFinale();
            } else {
                notify("スポットを登録しました。");
            }
        } catch (err) {
            $("spotError").textContent = err.message;
        } finally {
            $("spotSubmit").disabled = false;
        }
    });

    // ---------- 宝箱を開けたときの演出 ----------
    function showFinale() {
        const f = $("finale");
        f.classList.remove("opened");
        $("coins").innerHTML = "";
        const t = state && state.cleared ? new Date(state.cleared) : new Date();
        $("finaleTeam").textContent = (state ? state.team.name : "") + " ・ " +
            t.getHours() + "時" + String(t.getMinutes()).padStart(2, "0") + "分に発見";
        f.classList.add("open");
    }

    function openChest() {
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

    $("chest").addEventListener("click", openChest);
    $("chest").addEventListener("keydown", function(e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openChest(); }
    });

    $("finaleClose").addEventListener("click", function() {
        $("finale").classList.remove("open");
        showView("mapView");
        const t = spots.find(function(s) { return s.is_treasure; });
        if (t) map.setView([t.lat, t.lng], 13);
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
            b.innerHTML = escapeHtml(g.label) + (seenGroups.indexOf(g.key) < 0 ? "<span class=\"new\"></span>" : "");
            b.addEventListener("click", function() { openGroup(g.key); });
            tabs.appendChild(b);
        });
        if (!currentGroup || !state.pages[currentGroup]) {
            openGroup(open[open.length - 1].key);
        }
    }

    function openGroup(key) {
        currentGroup = key;
        if (seenGroups.indexOf(key) < 0) {
            seenGroups.push(key);
            store("nazo-seen-" + session.team, seenGroups);
        }
        const src = new URL("p/" + state.pages[key] + ".html?v=" + (window.NAZO_DATA.version || ""), location.href).href;
        if (!$("docFrame").src.endsWith(src)) {
            $("docFrame").style.height = "400px";
            $("docFrame").src = src;
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
            return state.pages[g] && state.solved.indexOf(p.id) < 0;
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
                const newly = GROUPS.filter(function(g) { return state.pages[g.key] && !before.pages[g.key]; });
                newly.forEach(function(g) { text += "\n新しい書類「" + g.label + "」が届いた。書類タブを見てね。"; });
                if (pid === "3-final") text += "\n…どこかで、何かが書き加えられる音がした。";
                addMsg("bot", text, "ok");
                applyState(true);
            } else if (res.status === "wrong") {
                addMsg("bot", "うーん、ちがうみたい。もう一度考えてみて。", "ng");
            } else if (res.status === "already") {
                addMsg("bot", "それはもう正解しているよ。", "ng");
                await refresh(false);
            } else {
                addMsg("bot", "その書類はまだ届いていないよ。", "ng");
            }
        } catch (err) {
            addMsg("bot", "送れなかった…（" + err.message + "）", "ng", "", false);
        }
    });

    // ---------- 状態の反映 ----------
    function applyState(fresh) {
        $("progressNote").textContent = "解いた書類 " + state.solved.length + " / " + state.puzzles.length;
        drawPoints(fresh);
        // 第三幕の最終謎を解くと、地図に「地点追加」が現れる
        const wasHidden = $("mapBar").hidden;
        $("mapBar").hidden = !state.spotUnlocked;
        if (wasHidden && state.spotUnlocked && fresh) {
            $("addModeButton").classList.add("appear");
        }
        const hasUnseen = GROUPS.some(function(g) { return state.pages[g.key] && seenGroups.indexOf(g.key) < 0; });
        if (hasUnseen && !$("docView").classList.contains("active")) $("dotDoc").classList.add("show");
        renderDocTabs();
        renderPuzzleSelect();
        stampDocs();
    }

    async function refresh(fresh) {
        state = await api.state(session.team, session.code);
        spots = await api.spots(session.team);
        drawSpots();
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
            addMsg("bot", "ようこそ、" + state.team.name + "。\n書類の答えがわかったら、ここで書類の番号を選んで答えを書いてね。");
        } else {
            chatLog.forEach(function(m) { addMsg(m[0], m[1], m[2], m[3], false); });
        }
        $("teamBadge").textContent = state.team.name;
        $("teamBadge").hidden = false;
        $("tabbar").hidden = false;
        applyState(false);
        showView(store("nazo-view") || "docView");
    }

    $("loginButton").addEventListener("click", async function() {
        const team = Number($("teamSelect").value);
        const code = "";
        $("loginError").textContent = "";
        try {
            await start(team, code);
        } catch (err) {
            session = null;
            $("loginError").textContent = err.message;
        }
    });

    $("resetButton").addEventListener("click", function() {
        const team = Number($("teamSelect").value);
        if (!confirm("チーム" + team + "の、この端末の進み具合をすべて消します。よいですか？")) return;
        api.reset(team);
        store("nazo-chat-" + team, []);
        store("nazo-seen-" + team, []);
        notify("チーム" + team + "の進み具合を消しました。");
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
        showView("loginView");
    }

    boot();
})();
