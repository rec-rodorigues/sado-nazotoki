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
        return { solved: {}, spots: [] };
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
        const pages = { act1: D.pages.act1 };
        for (const group of Object.keys(D.requires)) {
            const req = D.requires[group];
            // 第四幕は、宝箱のありかで合言葉を聞かれてはじめて届く
            if (group === "act4" && !data.asked) continue;
            if (req.every(function(p) { return solved[p]; })) {
                pages[group] = await decrypt("page:" + req.map(function(p) { return solved[p]; }).join("|"), D.pages[group]);
            }
        }
        let points = [];
        for (const p of D.puzzles) {
            if (solved[p.id]) points = points.concat(JSON.parse(await decrypt("p:" + solved[p.id], p.points)));
        }
        points.sort(function(a, b) { return a[0] - b[0]; });
        const treasure = data.spots.find(function(s) { return s.is_treasure; });
        return {
            team: TEAMS.find(function(t) { return t.id === team; }) || { id: team, name: "チーム" + team },
            solved: ids,
            puzzles: D.puzzles.map(function(p) { return { id: p.id, act: p.act, kind: p.kind }; }),
            points: points,
            total_points: D.total_points,
            pages: pages,
            cleared: treasure ? treasure.created_at : null,
            spotUnlocked: !!solved["3-final"],
            asked: !!data.asked
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
            const group = "act" + p.act;
            if (!st.pages[group]) return { status: "locked" };
            if (st.solved.indexOf(puzzleId) >= 0) return { status: "already" };
            const typed = normalize(answer);
            const i = p.hashes.indexOf(await hashAnswer(typed));
            if (i < 0) return { status: "wrong" };
            const data = load(team);
            data.solved[puzzleId] = await decrypt("c:" + typed, p.canon[i]);
            save(team, data);
            return { status: "correct", new_points: JSON.parse(await decrypt("p:" + data.solved[puzzleId], p.points)).length, state: await state(team) };
        },

        async spots(team) {
            return load(team).spots;
        },

        // 宝箱があるエリアか（第二幕の最終謎を解いていないと、場所を解読できない）
        async inTreasureArea(team, lat, lng) {
            const data = load(team);
            if (!data.solved["2-final"]) return false;
            const tip = JSON.parse(await decrypt("tip:" + data.solved["2-final"], D.tip));
            return distance(lat, lng, tip[0], tip[1]) <= D.radius_m;
        },

        async addSpot(team, code, spot) {
            const treasure = await this.inTreasureArea(team, spot.lat, spot.lng);
            // 宝箱のエリアでは、合言葉が正しいときだけ登録できる（カテゴリーは問わない）
            if (treasure && D.password.indexOf(await hashAnswer(normalize(spot.password))) < 0) {
                return { status: "bad_password" };
            }
            const data = load(team);
            data.spots.push({
                id: Date.now(), team_id: team, name: spot.name || "名前のない地点", category: spot.category,
                note: spot.note, lat: spot.lat, lng: spot.lng, is_treasure: treasure, created_at: new Date().toISOString()
            });
            save(team, data);
            return { status: treasure ? "treasure" : "added" };
        },

        // 宝箱のありかで合言葉を聞かれた（第四幕の書類が届く）
        markAsked(team) {
            const data = load(team);
            if (data.asked) return false;
            data.asked = true;
            save(team, data);
            return true;
        },

        reset(team) {
            try { localStorage.removeItem(key(team)); } catch (e) { /* なにもしない */ }
        }
    };
})();
