// =========================================
// サーバーとのやりとり
//   本番：Supabase の関数（nazo_list_teams / nazo_state / nazo_answer / nazo_add_spot）
//   試用：demo-data.js とこの端末の localStorage
// =========================================
(function() {
    const cfg = window.NAZO_CONFIG || {};
    const isDemo = !(cfg.supabaseUrl && cfg.supabaseKey);

    function normalize(text) {
        let t = String(text || "").normalize("NFKC").toLowerCase();
        t = t.replace(/[ァ-ヶ]/g, function(c) {
            return String.fromCharCode(c.charCodeAt(0) - 0x60);
        });
        return t.replace(/[\s・、。,.!！?？「」『』()（）\-]/g, "");
    }

    async function rpc(name, args) {
        const res = await fetch(cfg.supabaseUrl.replace(/\/$/, "") + "/rest/v1/rpc/" + name, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                apikey: cfg.supabaseKey,
                Authorization: "Bearer " + cfg.supabaseKey
            },
            body: JSON.stringify(args || {})
        });
        const body = await res.json().catch(function() { return null; });
        if (!res.ok) {
            throw new Error((body && body.message) || ("通信エラー（" + res.status + "）"));
        }
        return body;
    }

    async function select(table, query) {
        const res = await fetch(cfg.supabaseUrl.replace(/\/$/, "") + "/rest/v1/" + table + "?" + query, {
            headers: { apikey: cfg.supabaseKey, Authorization: "Bearer " + cfg.supabaseKey }
        });
        if (!res.ok) throw new Error("通信エラー（" + res.status + "）");
        return res.json();
    }

    // ---------- 試用モード ----------
    const D = window.NAZO_DEMO;
    const demoKey = function(team) { return "nazo-demo-" + team; };

    function demoLoad(team) {
        try {
            return JSON.parse(localStorage.getItem(demoKey(team))) || { solved: [], spots: [] };
        } catch (e) {
            return { solved: [], spots: [] };
        }
    }

    function demoSave(team, data) {
        try { localStorage.setItem(demoKey(team), JSON.stringify(data)); } catch (e) { /* 保存できなくても続ける */ }
    }

    async function sha(text) {
        const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("sado-nazo:" + text));
        return Array.from(new Uint8Array(buf)).map(function(b) { return b.toString(16).padStart(2, "0"); }).join("");
    }

    function demoState(team) {
        const data = demoLoad(team);
        const solved = data.solved;
        const has = function(id) { return solved.indexOf(id) >= 0; };
        const allSheets = function(act) {
            return D.puzzles.filter(function(p) { return p.act === act && p.kind === "sheet"; }).every(function(p) { return has(p.id); });
        };
        const groups = ["act1"];
        if (allSheets(1)) groups.push("act1final");
        if (has("1-final")) groups.push("act2");
        if (has("1-final") && allSheets(2)) groups.push("act2final");
        if (has("2-final")) groups.push("act3");
        if (has("2-final") && allSheets(3)) groups.push("act3final");
        if (has("3-final")) groups.push("act4");
        const pages = {};
        groups.forEach(function(g) { pages[g] = D.pages[g]; });
        const idx = new Set();
        D.puzzles.forEach(function(p) { if (has(p.id)) p.points.forEach(function(i) { idx.add(i); }); });
        const treasure = data.spots.find(function(s) { return s.is_treasure; });
        return {
            team: { id: team, name: "チーム" + team },
            solved: solved.slice(),
            puzzles: D.puzzles.map(function(p) { return { id: p.id, act: p.act, kind: p.kind }; }),
            points: Array.from(idx).sort(function(a, b) { return a - b; }).map(function(i) { return [i, D.points[i][0], D.points[i][1]]; }),
            total_points: D.points.length,
            pages: pages,
            cleared: treasure ? treasure.created_at : null
        };
    }

    function distance(lat1, lng1, lat2, lng2) {
        const r = Math.PI / 180;
        const a = Math.pow(Math.sin((lat1 - lat2) * r / 2), 2) +
            Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.pow(Math.sin((lng1 - lng2) * r / 2), 2);
        return 6371000 * 2 * Math.asin(Math.sqrt(a));
    }

    const api = {
        isDemo: isDemo,
        normalize: normalize,

        async listTeams() {
            if (isDemo) return [1, 2, 3, 4].map(function(i) { return { id: i, name: "チーム" + i }; });
            return rpc("nazo_list_teams");
        },

        async state(team, code) {
            if (isDemo) return demoState(team);
            return rpc("nazo_state", { p_team: team, p_code: code });
        },

        async answer(team, code, puzzleId, answer) {
            if (!isDemo) return rpc("nazo_answer", { p_team: team, p_code: code, p_puzzle: puzzleId, p_answer: answer });
            const st = demoState(team);
            const p = D.puzzles.find(function(x) { return x.id === puzzleId; });
            if (!p) return { status: "unknown" };
            const group = "act" + p.act + (p.kind === "final" ? "final" : "");
            if (!st.pages[group]) return { status: "locked" };
            if (st.solved.indexOf(puzzleId) >= 0) return { status: "already" };
            const h = await sha(normalize(answer));
            if (p.hashes.indexOf(h) < 0) return { status: "wrong" };
            const data = demoLoad(team);
            data.solved.push(puzzleId);
            demoSave(team, data);
            return { status: "correct", new_points: p.points.length, state: demoState(team) };
        },

        async spots(team) {
            if (isDemo) return demoLoad(team).spots;
            return select("nazo_spots", "select=*&team_id=eq." + encodeURIComponent(team) + "&order=id");
        },

        async addSpot(team, code, spot) {
            if (!isDemo) {
                return rpc("nazo_add_spot", {
                    p_team: team, p_code: code, p_name: spot.name, p_category: spot.category,
                    p_note: spot.note, p_lat: spot.lat, p_lng: spot.lng, p_password: spot.password
                });
            }
            const h = await sha(normalize(spot.password));
            if (D.password.indexOf(h) < 0) return { status: "bad_password" };
            const dist = distance(spot.lat, spot.lng, D.tip[0], D.tip[1]);
            const treasure = dist <= 1500;
            const data = demoLoad(team);
            data.spots.push({
                id: Date.now(), team_id: team, name: spot.name || "名前のない地点", category: spot.category,
                note: spot.note, lat: spot.lat, lng: spot.lng, is_treasure: treasure, created_at: new Date().toISOString()
            });
            demoSave(team, data);
            return { status: treasure ? "treasure" : "added", distance_m: Math.round(dist) };
        },

        async allSolves() {
            if (isDemo) return [];
            return select("nazo_solves", "select=team_id,puzzle_id,solved_at&order=solved_at");
        }
    };

    window.NazoApi = api;
})();
