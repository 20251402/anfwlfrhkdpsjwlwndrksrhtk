"use strict";
/**
 * 물질과 에너지 OMR — 백엔드 (Netlify Functions + Netlify Blobs)
 *
 * 계정은 웹에서 만들 수 없고, 관리자 토큰으로만 생성·삭제한다.
 * 비밀번호는 salt + scrypt 해시로만 보관한다. 되돌릴 수 있는 형태로는 어디에도
 * 저장하지 않으므로 관리자도 조회할 수 없고, 잊어버리면 1234로 초기화한다.
 */
const crypto = require("crypto");
const { getStore } = require("@netlify/blobs");

const SEED = [
  { id: "hwanil1", name: "김민재", pw: "1234" },
  { id: "hwanil2", name: "박성현", pw: "1234" },
  { id: "hwanil3", name: "정해유", pw: "1234" },
  { id: "hwanil4", name: "김범준", pw: "1234" },
  { id: "hwanil5", name: "김윤수", pw: "1234" },
  { id: "hwanil6", name: "김진욱", pw: "1234" },
];

const EXAM_UNLOCK = Date.parse("2026-09-30T18:00:00+09:00"); // 시험 전날 오후 6시 (KST)
const IDLE_MS = 20 * 60 * 1000;      // 이 시간 동안 활동 없으면 다른 기기에서 로그인 허용
const LONG_MS = 60 * 24 * 60 * 60 * 1000;
const SHORT_MS = 12 * 60 * 60 * 1000;

const users = () => getStore({ name: "omr-users", consistency: "strong" });
const states = () => getStore({ name: "omr-state", consistency: "strong" });

/* ---------- 비밀번호 ---------- */
function hashPw(pw, salt) {
  return crypto.scryptSync(pw, salt, 32).toString("hex");
}
function makeUser(id, name, pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  return {
    id, name, salt,
    hash: hashPw(pw, salt),
    mustChange: true,
    createdAt: Date.now(),
    pwUpdatedAt: Date.now(),
    lastLogin: 0,
    session: null,
  };
}

/* ---------- 응답 ---------- */
const J = (code, body) => ({
  statusCode: code,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  body: JSON.stringify(body),
});

async function seedIfEmpty(st) {
  const list = await st.get("index", { type: "json" });
  if (list && list.length) return list;
  const ids = [];
  for (const s of SEED) {
    await st.setJSON("u/" + s.id, makeUser(s.id, s.name, s.pw));
    ids.push(s.id);
  }
  await st.setJSON("index", ids);
  return ids;
}

async function auth(st, event) {
  const h = event.headers.authorization || event.headers.Authorization || "";
  const token = h.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const ids = (await st.get("index", { type: "json" })) || [];
  for (const id of ids) {
    const u = await st.get("u/" + id, { type: "json" });
    if (u && u.session && u.session.token === token) {
      if (u.session.exp < Date.now()) return null;
      return u;
    }
  }
  return null;
}
function isAdmin(event) {
  const t = event.headers["x-admin-token"] || event.headers["X-Admin-Token"] || "";
  return !!process.env.ADMIN_TOKEN && t === process.env.ADMIN_TOKEN;
}
const pub = (u) => ({
  id: u.id, name: u.name, mustChange: !!u.mustChange, lastLogin: u.lastLogin,
});

/* ---------- 오래 걸린 문제 판정용 평균 ---------- */
async function globalAverages(st, ss) {
  const ids = (await st.get("index", { type: "json" })) || [];
  const sum = {}, cnt = {};
  for (const id of ids) {
    const s = await ss.get("s/" + id, { type: "json" });
    if (!s || !s.times) continue;
    for (const k in s.times) {
      const arr = s.times[k];
      if (!arr || !arr.length) continue;
      const best = Math.min.apply(null, arr);     // 한 문항은 최단 소요 시간으로 대표
      const key = k.split("|")[1] || k;           // 세트 구분 없이 문항 번호로 묶는다
      sum[key] = (sum[key] || 0) + best;
      cnt[key] = (cnt[key] || 0) + 1;
    }
  }
  const avg = {};
  for (const k in sum) avg[k] = sum[k] / cnt[k];
  return avg;
}

const SETS = ["o", "v1", "v2", "v3", "v4", "v5"];

function buildExam(state, avg) {
  const saved = state.saved || {}, times = state.times || {};
  const flagged = {};   // "p-n" -> 이유
  SETS.forEach(function (sl) {
    const m = saved[sl] || {};
    for (const k in m) {
      const r = m[k];
      if (!r || !r.tried) continue;
      if (r.tried > 1 || !r.ok) flagged[k] = flagged[k] || "틀림";
    }
  });
  for (const tk in times) {
    const parts = tk.split("|");
    const k = parts[1] || tk;
    const arr = times[tk] || [];
    if (!arr.length || !avg[k]) continue;
    const best = Math.min.apply(null, arr);
    if (best > avg[k]) flagged[k] = flagged[k] === "틀림" ? "틀림·오래" : "오래";
  }
  const doneSets = SETS.filter(function (sl) {
    return Object.keys(saved[sl] || {}).length >= 71;
  });
  const allDone = doneSets.length === SETS.length;
  const items = [];
  Object.keys(flagged).forEach(function (k) {
    const attempted = SETS.filter(function (sl) { return (saved[sl] || {})[k]; });
    let pick;
    if (allDone) pick = SETS;
    else {
      pick = SETS.filter(function (sl) { return attempted.indexOf(sl) < 0; });
      if (pick.indexOf("o") < 0 && attempted.indexOf("o") < 0) pick.unshift("o");
      if (!pick.length) pick = SETS;
    }
    pick.forEach(function (sl) {
      items.push({ set: sl, key: k, why: flagged[k] });
    });
  });
  // 세트가 골고루 섞이도록 결정적으로 정렬 후 섞는다
  items.sort(function (a, b) {
    const ha = crypto.createHash("md5").update(a.set + a.key).digest("hex");
    const hb = crypto.createHash("md5").update(b.set + b.key).digest("hex");
    return ha < hb ? -1 : 1;
  });
  return { items: items, allDone: allDone, flagged: Object.keys(flagged).length };
}

/* ---------- 라우터 ---------- */
exports.handler = async function (event) {
  const path = (event.path || "").replace(/^.*\/api/, "").replace(/\/$/, "") || "/";
  let body = {};
  try { body = event.body ? JSON.parse(event.body) : {}; } catch (e) {}
  const st = users(), ss = states();

  try {
    await seedIfEmpty(st);

    /* --- 로그인 --- */
    if (path === "/login" && event.httpMethod === "POST") {
      const id = String(body.id || "").trim();
      const u = await st.get("u/" + id, { type: "json" });
      if (!u) return J(401, { error: "아이디 또는 비밀번호가 맞지 않습니다." });
      if (hashPw(String(body.pw || ""), u.salt) !== u.hash) {
        return J(401, { error: "아이디 또는 비밀번호가 맞지 않습니다." });
      }
      const s = u.session;
      const live = s && s.exp > Date.now() && Date.now() - (s.seen || 0) < IDLE_MS;
      if (live && !body.force && s.device !== body.device) {
        return J(409, {
          error: "다른 기기에서 로그인되어 있습니다.",
          other: { at: s.seen || s.at, ua: s.ua || "" },
        });
      }
      const token = crypto.randomBytes(24).toString("hex");
      u.session = {
        token: token,
        device: String(body.device || crypto.randomBytes(8).toString("hex")),
        ua: String((event.headers["user-agent"] || "").slice(0, 120)),
        at: Date.now(), seen: Date.now(),
        exp: Date.now() + (body.remember ? LONG_MS : SHORT_MS),
      };
      u.lastLogin = Date.now();
      await st.setJSON("u/" + id, u);
      return J(200, { token: token, user: pub(u), exp: u.session.exp });
    }

    /* --- 아래는 로그인 필요 --- */
    const me = await auth(st, event);
    if (path === "/me") {
      if (!me) return J(401, { error: "로그인이 필요합니다." });
      me.session.seen = Date.now();
      await st.setJSON("u/" + me.id, me);
      return J(200, { user: pub(me) });
    }
    if (path === "/logout" && event.httpMethod === "POST") {
      if (me) { me.session = null; await st.setJSON("u/" + me.id, me); }
      return J(200, { ok: true });
    }
    if (path === "/password" && event.httpMethod === "POST") {
      if (!me) return J(401, { error: "로그인이 필요합니다." });
      const cur = String(body.current || ""), next = String(body.next || "");
      if (hashPw(cur, me.salt) !== me.hash) return J(400, { error: "현재 비밀번호가 맞지 않습니다." });
      if (next.length < 4) return J(400, { error: "새 비밀번호는 4자 이상이어야 합니다." });
      if (next !== String(body.confirm || "")) return J(400, { error: "새 비밀번호 확인이 일치하지 않습니다." });
      if (next === cur) return J(400, { error: "이전과 다른 비밀번호를 쓰세요." });
      me.salt = crypto.randomBytes(16).toString("hex");
      me.hash = hashPw(next, me.salt);
      me.mustChange = false;
      me.pwUpdatedAt = Date.now();
      await st.setJSON("u/" + me.id, me);
      return J(200, { ok: true, user: pub(me) });
    }
    if (path === "/state") {
      if (!me) return J(401, { error: "로그인이 필요합니다." });
      if (event.httpMethod === "GET") {
        const s = (await ss.get("s/" + me.id, { type: "json" })) || { saved: {}, times: {} };
        return J(200, s);
      }
      if (event.httpMethod === "POST") {
        const s = {
          saved: body.saved || {}, times: body.times || {},
          updatedAt: Date.now(), by: me.id,
        };
        await ss.setJSON("s/" + me.id, s);
        me.session.seen = Date.now();
        await st.setJSON("u/" + me.id, me);
        return J(200, { ok: true, updatedAt: s.updatedAt });
      }
    }
    if (path === "/exam") {
      if (!me) return J(401, { error: "로그인이 필요합니다." });
      const now = Date.now();
      if (now < EXAM_UNLOCK && !isAdmin(event)) {
        return J(200, { locked: true, unlockAt: EXAM_UNLOCK, now: now });
      }
      const s = (await ss.get("s/" + me.id, { type: "json" })) || { saved: {}, times: {} };
      const avg = await globalAverages(st, ss);
      const out = buildExam(s, avg);
      out.locked = false;
      out.unlockAt = EXAM_UNLOCK;
      out.now = now;
      return J(200, out);
    }

    /* --- 관리자 --- */
    if (path.indexOf("/admin") === 0) {
      if (!isAdmin(event)) return J(403, { error: "관리자 토큰이 필요합니다." });
      const ids = (await st.get("index", { type: "json" })) || [];
      if (path === "/admin/users" && event.httpMethod === "GET") {
        const out = [];
        for (const id of ids) {
          const u = await st.get("u/" + id, { type: "json" });
          if (!u) continue;
          const s = await ss.get("s/" + id, { type: "json" });
          let solved = 0, wrong = 0;
          if (s && s.saved) {
            for (const sl in s.saved) {
              for (const k in s.saved[sl]) {
                const r = s.saved[sl][k];
                if (r && r.tried) { solved++; if (!r.ok) wrong++; }
              }
            }
          }
          out.push({
            id: u.id, name: u.name, mustChange: !!u.mustChange,
            pwUpdatedAt: u.pwUpdatedAt, lastLogin: u.lastLogin,
            online: !!(u.session && u.session.exp > Date.now()
              && Date.now() - (u.session.seen || 0) < IDLE_MS),
            device: u.session ? u.session.ua : "",
            solved: solved, wrong: wrong,
          });
        }
        return J(200, { users: out });
      }
      if (path === "/admin/user" && event.httpMethod === "POST") {
        const id = String(body.id || "").trim();
        if (!id) return J(400, { error: "id가 필요합니다." });
        if (body.action === "create") {
          if (ids.indexOf(id) >= 0) return J(400, { error: "이미 있는 아이디입니다." });
          await st.setJSON("u/" + id, makeUser(id, String(body.name || id), String(body.pw || "1234")));
          ids.push(id);
          await st.setJSON("index", ids);
          return J(200, { ok: true });
        }
        if (body.action === "delete") {
          await st.delete("u/" + id);
          await ss.delete("s/" + id);
          await st.setJSON("index", ids.filter(function (x) { return x !== id; }));
          return J(200, { ok: true });
        }
        if (body.action === "reset") {
          const u = await st.get("u/" + id, { type: "json" });
          if (!u) return J(404, { error: "없는 아이디입니다." });
          u.salt = crypto.randomBytes(16).toString("hex");
          u.hash = hashPw("1234", u.salt);      // 초기화는 언제나 1234
          u.mustChange = true;
          u.session = null;
          u.pwUpdatedAt = Date.now();
          await st.setJSON("u/" + id, u);
          return J(200, { ok: true });
        }
        if (body.action === "kick") {
          const u = await st.get("u/" + id, { type: "json" });
          if (u) { u.session = null; await st.setJSON("u/" + id, u); }
          return J(200, { ok: true });
        }
        return J(400, { error: "알 수 없는 action" });
      }
    }
    return J(404, { error: "없는 경로: " + path });
  } catch (e) {
    return J(500, { error: String((e && e.message) || e) });
  }
};
