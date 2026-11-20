// =========================================
// 答えの判定と進み具合の保存（サーバーなし）
//   進み具合は、この端末のブラウザ（localStorage）に保存する。
//   答えは data.js にハッシュでしか入っていない。正解すると、打った答えから
//   正式な答えを復元し、それを鍵にして点の座標・次の書類・宝箱の場所を解読する。
// =========================================
(function() {
    const D = window.NAZO_DATA;
    const TEAMS = [1, 2, 3, 4].map(function(i) { return { id: i, name: "チーム" + i }; });

    function normalize(text) {
        let t = String(text || "").normalize("NFKC").toLowerCase();
        t = t.replace(/[ァ-ヶ]/g, function(c) {
            return String.fromCharCode(c.charCodeAt(0) - 0x60);
        });
        return t.replace(/[\s・、。,.!！?？「」『』()（）\-]/g, "");
    }

    const enc = new TextEncoder();

    async function sha(text) {
        return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)));
    }

    function toHex(bytes) {
        return Array.from(bytes).map(function(b) { return b.toString(16).padStart(2, "0"); }).join("");
    }

    async function hashAnswer(text) {
        return toHex(await sha("sado-nazo:" + text));
    }

    async function decrypt(seed, hex) {
        const data = new Uint8Array(hex.match(/../g).map(function(x) { return parseInt(x, 16); }));
        const out = new Uint8Array(data.length);
        let block = null;
        for (let i = 0; i < data.length; i++) {
            if (i % 32 === 0) block = await sha(seed + ":" + (i / 32));
            out[i] = data[i] ^ block[i % 32];
        }
        return new TextDecoder().decode(out);
    }

    const key = function(team) { return "nazo-progress-" + team; };

    function load(team) {
        try {
            const v = JSON.parse(localStorage.getItem(key(team)));
            if (v && v.solved && !Array.isArray(v.solved)) return v;
        } catch (e) { /* 読めなければ最初から */ }
        return { solved: {} };
    }

    function save(team, data) {
        try {
            localStorage.setItem(key(team), JSON.stringify(data));
        } catch (e) {
            throw new Error("この端末に保存できませんでした。プライベートモードを切ってください。");
        }
    }

    async function state(team) {
        const data = load(team);
        const solved = data.solved;            // { 書類番号: 正式な答え }
        const ids = Object.keys(solved);
        let points = [];
        for (const p of D.puzzles) {
            if (solved[p.id]) points = points.concat(JSON.parse(await decrypt("p:" + solved[p.id], p.points)));
        }
        points.sort(function(a, b) { return a[0] - b[0]; });
        return {
            team: TEAMS.find(function(t) { return t.id === team; }) || { id: team, name: "チーム" + team },
            solved: ids,
            puzzles: D.puzzles.map(function(p) { return { id: p.id, act: p.act, kind: p.kind }; }),
            points: points,
            total_points: D.total_points,
            pages: D.pages,
            // 第三幕をすべて解くと「宝箱を探す」が使える
            searchUnlocked: D.unlock.every(function(p) { return solved[p]; }),
            shovels: D.shovels,
            used: data.used || 0,
            dug: data.dug || [],             // 外れた場所 [[lat, lng], ...]
            found: data.found || null,      // 宝箱を掘り当てた場所 [lat, lng]
            cleared: data.cleared || null    // 宝箱を開けた時刻
        };
    }

    function distance(lat1, lng1, lat2, lng2) {
        const r = Math.PI / 180;
        const a = Math.pow(Math.sin((lat1 - lat2) * r / 2), 2) +
            Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.pow(Math.sin((lng1 - lng2) * r / 2), 2);
        return 6371000 * 2 * Math.asin(Math.sqrt(a));
    }

    window.NazoApi = {
        normalize: normalize,

        async listTeams() {
            return TEAMS;
        },

        async state(team) {
            return state(team);
        },

        async answer(team, code, puzzleId, answer) {
            const st = await state(team);
            const p = D.puzzles.find(function(x) { return x.id === puzzleId; });
            if (!p) return { status: "unknown" };
            if (st.solved.indexOf(puzzleId) >= 0) return { status: "already" };
            const typed = normalize(answer);
            const i = p.hashes.indexOf(await hashAnswer(typed));
            if (i < 0) return { status: "wrong" };
            const data = load(team);
            data.solved[puzzleId] = await decrypt("c:" + typed, p.canon[i]);
            save(team, data);
            return { status: "correct", new_points: JSON.parse(await decrypt("p:" + data.solved[puzzleId], p.points)).length, state: await state(team) };
        },

        // この付近を探す。外れるとスコップの耐久力が1減る
        async search(team, lat, lng) {
            const st = await state(team);
            if (!st.searchUnlocked) return { status: "locked" };
            if (st.found) return { status: "found", found: st.found };
            if (st.used >= st.shovels) return { status: "broken" };
            const data = load(team);
            const tip = JSON.parse(await decrypt("tip:" + data.solved["3-final"], D.tip));
            if (distance(lat, lng, tip[0], tip[1]) <= D.radius_m) {
                data.found = [lat, lng];
                save(team, data);
                return { status: "found", found: data.found };
            }
            data.used = (data.used || 0) + 1;
            data.dug = (data.dug || []).concat([[lat, lng]]);
            save(team, data);
            return { status: data.used >= D.shovels ? "broken" : "nothing", left: D.shovels - data.used };
        },

        // 合言葉で宝箱を開ける
        async open(team, password) {
            const data = load(team);
            if (!data.found) return { status: "locked" };
            if (D.password.indexOf(await hashAnswer(normalize(password))) < 0) return { status: "bad_password" };
            if (!data.cleared) { data.cleared = new Date().toISOString(); save(team, data); }
            return { status: "opened", cleared: data.cleared };
        },

        // 運営用：スコップの回数を戻す
        async refill(team, staffPassword) {
            if (D.staff.indexOf(await hashAnswer(normalize(staffPassword))) < 0) return false;
            const data = load(team);
            data.used = 0;
            save(team, data);
            return true;
        },

        reset(team) {
            try { localStorage.removeItem(key(team)); } catch (e) { /* なにもしない */ }
        }
    };
})();
