// 旅帳推播伺服器（Cloudflare Worker）
// 功能：旅伴記帳時，推播通知給同一趟旅程的其他人
const FIREBASE_API_KEY = "AIzaSyDjZ_Memp-yC8LRuGyOkpDlwrqfswqDmik";
const FIREBASE_PROJECT = "travel-expense-app-fbde7";
const ALLOWED_ORIGIN = "https://zackkao66.github.io";
const APP_URL = "https://zackkao66.github.io/tripledger/";
const VAPID_PUBLIC = "BJnCq4_NpkESaIxVnX4tvBFGHRnGE1n0Q4XMtnQCfT1IFcRC4WDZVJkq49-nXkNleE_xMIUgFdoXTOWAK23nSNs";
// 推播私鑰改存在 Cloudflare 加密設定 VAPID_PRIVATE（不放在程式碼裡，程式碼可以公開）
let VAPID_PRIVATE_JWK = null;
const loadKeys = env => { if (!VAPID_PRIVATE_JWK && env.VAPID_PRIVATE) VAPID_PRIVATE_JWK = JSON.parse(env.VAPID_PRIVATE); };

const enc = new TextEncoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const concat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };

function cors(origin) {
  return { "Access-Control-Allow-Origin": origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "content-type", "Vary": "Origin" };
}
const json = (data, status, origin) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...cors(origin) } });

// 用 Firebase 驗證登入者身分
async function whoIs(idToken) {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idToken }) });
  if (!r.ok) return null;
  const d = await r.json();
  return d.users?.[0]?.localId || null;
}
async function whoFull(idToken) {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idToken }) });
  if (!r.ok) return null;
  return (await r.json()).users?.[0] || null;
}
// ---- 轉移碼：免登入角色從 Safari 搬到主畫面 App（或換手機）----
const XF_ABC = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
async function mintCustomToken(env, uid) {
  const sa = JSON.parse(env.FIREBASE_SA);
  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const key = await crypto.subtle.importKey("pkcs8", unb64u(pem.replace(/\+/g, "-").replace(/\//g, "_")), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const body = b64u(enc.encode(JSON.stringify({ iss: sa.client_email, sub: sa.client_email, aud: "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit", iat: now, exp: now + 3600, uid })));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(`${head}.${body}`));
  return `${head}.${body}.${b64u(sig)}`;
}
async function xferNew(b, env, origin) {
  if (!env.FIREBASE_SA) return json({ error: "伺服器尚未設定" }, 500, origin);
  const u = await whoFull(b.idToken); if (!u) return json({ error: "請重新登入" }, 401, origin);
  if ((u.providerUserInfo || []).some(p => p.providerId === "google.com")) return json({ error: "google", detail: "已綁定 Google，直接用 Google 登入就能找回" }, 400, origin);
  const old = await env.PUSH.get("xu:" + u.localId); if (old) await env.PUSH.delete("xf:" + old);
  const r = crypto.getRandomValues(new Uint8Array(6)); const code = [...r].map(x => XF_ABC[x % 32]).join("");
  await env.PUSH.put("xf:" + code, JSON.stringify({ uid: u.localId, ts: Date.now() }), { expirationTtl: 1800 });
  await env.PUSH.put("xu:" + u.localId, code, { expirationTtl: 1800 });
  return json({ ok: true, code, ttl: 1800 }, 200, origin);
}
async function xferUse(b, env, origin, req) {
  if (!env.FIREBASE_SA) return json({ error: "伺服器尚未設定" }, 500, origin);
  const ip = req.headers.get("CF-Connecting-IP") || "x"; const rk = "xr:" + ip;
  const n = +(await env.PUSH.get(rk) || 0); if (n >= 12) return json({ error: "too many", detail: "嘗試太多次，請 15 分鐘後再試" }, 429, origin);
  const code = String(b.code || "").toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/O/g, "0").replace(/I/g, "1");
  const rec = code.length === 6 ? await env.PUSH.get("xf:" + code) : null;
  if (!rec) { await env.PUSH.put(rk, String(n + 1), { expirationTtl: 900 }); return json({ error: "bad code", detail: "轉移碼不對或已過期（30 分鐘有效）" }, 404, origin); }
  const { uid } = JSON.parse(rec);
  await env.PUSH.delete("xf:" + code); await env.PUSH.delete("xu:" + uid);
  try { return json({ ok: true, token: await mintCustomToken(env, uid) }, 200, origin); }
  catch (e) { return json({ error: "mint", detail: String(e.message || e).slice(0, 120) }, 500, origin); }
}
// 讀取旅程成員（以登入者身分讀，受 Firestore 規則保護）
async function tripMembers(idToken, tripId) {
  const r = await fetch(`https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/trips/${encodeURIComponent(tripId)}`, { headers: { Authorization: `Bearer ${idToken}` } });
  if (!r.ok) return null;
  const d = await r.json();
  return (d.fields?.memberUids?.arrayValue?.values || []).map(v => v.stringValue).filter(Boolean);
}

// ---- Web Push（RFC 8291 加密 + VAPID 簽章）----
async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, len * 8));
}
async function encryptPayload(sub, payload) {
  const uaPublic = unb64u(sub.keys.p256dh), authSecret = unb64u(sub.keys.auth);
  const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, local.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(enc.encode(payload), new Uint8Array([2]))));
  const header = new Uint8Array(21); header.set(salt, 0); new DataView(header.buffer).setUint32(16, 4096); header[20] = 65;
  return concat(header, asPublic, cipher);
}
let signKey = null;
async function vapidAuth(endpoint) {
  if (!VAPID_PRIVATE_JWK) throw new Error("缺少 VAPID_PRIVATE 設定");
  signKey ||= await crypto.subtle.importKey("jwk", VAPID_PRIVATE_JWK, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: APP_URL })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signKey, enc.encode(`${head}.${body}`));
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${VAPID_PUBLIC}`;
}
async function sendPush(sub, data) {
  const body = await encryptPayload(sub, JSON.stringify(data));
  const r = await fetch(sub.endpoint, { method: "POST", headers: { Authorization: await vapidAuth(sub.endpoint), "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "86400", Urgency: "high" }, body });
  return r.status;
}


// ---- 管理者身分讀取 Firestore（每晚摘要用，需要在 Cloudflare 設定 FIREBASE_SA 密鑰）----
let saToken = null, saExp = 0;
async function adminToken(env) {
  if (saToken && Date.now() < saExp) return saToken;
  const sa = JSON.parse(env.FIREBASE_SA);
  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const key = await crypto.subtle.importKey("pkcs8", unb64u(pem.replace(/\+/g, "-").replace(/\//g, "_")), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const body = b64u(enc.encode(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/datastore", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(`${head}.${body}`));
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${head}.${body}.${b64u(sig)}` });
  const d = await r.json();
  if (!d.access_token) throw new Error("token " + JSON.stringify(d));
  saToken = d.access_token; saExp = Date.now() + 50 * 60 * 1000;
  return saToken;
}
const FS = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;
const val = v => {
  if (!v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(val);
  if ("mapValue" in v) { const o = Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, val(x)])); return (Object.keys(o).length === 1 && Array.isArray(o.__a)) ? o.__a : o; }
  return null;
};
const docVal = d => ({ id: d.name.split("/").pop(), ...val({ mapValue: { fields: d.fields || {} } }) });
async function runQuery(tok, parent, q) {
  const r = await fetch(`${FS}${parent ? "/" + parent : ""}:runQuery`, { method: "POST", headers: { Authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: JSON.stringify({ structuredQuery: q }) });
  const rows = await r.json();
  if (!Array.isArray(rows)) throw new Error("query " + JSON.stringify(rows));
  return rows.filter(x => x.document).map(x => docVal(x.document));
}
const eqF = (f, v) => ({ fieldFilter: { field: { fieldPath: f }, op: "EQUAL", value: { stringValue: v } } });
const TZ = { JP: "Asia/Tokyo", KR: "Asia/Seoul", TH: "Asia/Bangkok", VN: "Asia/Ho_Chi_Minh", SG: "Asia/Singapore", MY: "Asia/Kuala_Lumpur", ID: "Asia/Jakarta", PH: "Asia/Manila", HK: "Asia/Hong_Kong", MO: "Asia/Macau", CN: "Asia/Shanghai", AU: "Australia/Sydney", NZ: "Pacific/Auckland", US: "America/Los_Angeles", CA: "America/Vancouver", GB: "Europe/London", FR: "Europe/Paris", DE: "Europe/Berlin", IT: "Europe/Rome", ES: "Europe/Madrid", CH: "Europe/Zurich", NL: "Europe/Amsterdam", AT: "Europe/Vienna", CZ: "Europe/Prague", SE: "Europe/Stockholm", ZA: "Africa/Johannesburg", TR: "Europe/Istanbul", AE: "Asia/Dubai", IN: "Asia/Kolkata" };
function localParts(iso, at) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ[iso] || "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(at).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}
const finalTWD = e => (e.actualTWD != null && e.actualTWD !== "") ? Number(e.actualTWD) : Number(e.twd || 0);
function sharesOf(e, v) {
  const sp = (e.split && e.split.length) ? e.split : [e.payer]; const out = {};
  if (e.splitMode === "unit" && Array.isArray(e.groups)) {
    const gs = e.groups.map(g => (g || []).filter(id => sp.includes(id))).filter(g => g.length);
    if (gs.length) { gs.forEach(g => g.forEach(id => out[id] = (out[id] || 0) + v / gs.length / g.length)); return out; }
  }
  if (e.splitMode === "shares" || e.splitMode === "exact") {
    const w = sp.map(id => Math.max(0, Number(e.weights?.[id] || 0))); const sum = w.reduce((a, b) => a + b, 0);
    if (sum > 0) { sp.forEach((id, i) => out[id] = v * w[i] / sum); return out; }
  }
  sp.forEach(id => out[id] = v / sp.length); return out;
}
const SYM = { JPY: "¥", KRW: "₩", USD: "US$", EUR: "€", GBP: "£", THB: "฿", HKD: "HK$", CNY: "¥", SGD: "S$", AUD: "A$", VND: "₫" };
const fmt = n => Math.round(n).toLocaleString("en-US");
async function dailySummary(env, at = new Date(), force = null, onlyUid = null) {
  const tok = await adminToken(env);
  const yday = new Date(at.getTime() - 36 * 3600 * 1000).toISOString().slice(0, 10);
  let trips;
  if (force) {
    const r = await fetch(`${FS}/trips/${encodeURIComponent(force)}`, { headers: { Authorization: `Bearer ${tok}` } });
    const d = await r.json(); if (!d.fields) throw new Error("trip " + JSON.stringify(d).slice(0, 200));
    trips = [docVal(d)];
  } else trips = await runQuery(tok, null, { from: [{ collectionId: "trips" }], where: { fieldFilter: { field: { fieldPath: "end" }, op: "GREATER_THAN_OR_EQUAL", value: { stringValue: yday } } } });
  let sent = 0; const info = { subs: 0, failed: [] };
  for (const t of trips) {
    if (!force && (t.settled || !t.start)) continue;
    const { date, hour } = localParts(t.iso, at);
    if (!force && hour !== 22) continue;
    if (!force && (date < t.start || date > t.end)) continue;
    const key = `daily:${t.id}:${date}`;
    if (!force && await env.PUSH.get(key)) continue;
    const all = (await runQuery(tok, `trips/${t.id}`, { from: [{ collectionId: "expenses" }] })).filter(e => (e.kind || "expense") === "expense");
    const todays = all.filter(e => e.date === date);
    if (!todays.length && !force) continue;
    const dayTWD = todays.reduce((a, e) => a + finalTWD(e), 0);
    const dayLocal = todays.filter(e => e.cur === t.currency).reduce((a, e) => a + Number(e.amount || 0), 0);
    const totalTWD = all.reduce((a, e) => a + finalTWD(e), 0);
    const shareAll = {}, shareDay = {};
    for (const e of all) { const sh = sharesOf(e, finalTWD(e)); for (const id in sh) { shareAll[id] = (shareAll[id] || 0) + sh[id]; if (e.date === date) shareDay[id] = (shareDay[id] || 0) + sh[id]; } }
    const loc = t.currency && t.currency !== "TWD" && dayLocal ? `（${SYM[t.currency] || t.currency + " "}${fmt(dayLocal)}）` : "";
    for (const m of (t.members || [])) {
      if (!m.uid || (onlyUid && m.uid !== onlyUid)) continue;
      const subs = JSON.parse(await env.PUSH.get("u:" + m.uid) || "[]").filter(s => force || s.prefs?.daily !== false);
      info.subs += subs.length;
      if (!subs.length) continue;
      let mine = shareAll[m.id] || 0;
      if (Number(t.budget) > 0) {
        const priv = await runQuery(tok, `users/${m.uid}`, { from: [{ collectionId: "private" }], where: eqF("tripId", t.id) }).catch(() => []);
        mine += priv.reduce((a, e) => a + finalTWD(e), 0);
      }
      let body = todays.length ? `今天全團花了 NT$${fmt(dayTWD)}${loc}，共 ${todays.length} 筆；你分攤 NT$${fmt(shareDay[m.id] || 0)}。` : `今天還沒有花費紀錄。`;
      if (Number(t.budget) > 0) { const left = t.budget - mine; body += left >= 0 ? `你的預算還剩 NT$${fmt(left)}（${Math.round(left / t.budget * 100)}%）。` : `你的預算已超出 NT$${fmt(-left)}。`; }
      else body += `全程累計 NT$${fmt(totalTWD)}。`;
      const data = { title: `${t.name}・今日花費`, body, url: APP_URL + "#trip-" + t.id, tag: "daily-" + t.id };
      for (const s of subs) { try { const st = await sendPush(s, data); if (st < 300) sent++; else info.failed.push(st); } catch (e) { info.failed.push(String(e.message || e).slice(0, 80)); } }
    }
    if (!force) await env.PUSH.put(key, "1", { expirationTtl: 3 * 86400 });
  }
  return force ? { sent, ...info } : sent;
}

// Google 地圖短網址 → 座標
function parseMapUrl(u) {
  let m = u.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) || u.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) || u.match(/[?&](?:q|query|ll|center|destination)=(-?\d+\.\d+)(?:,|%2C)\s*(-?\d+\.\d+)/i);
  if (!m) return null;
  const lat = Number(m[1]), lng = Number(m[2]);
  if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  let name = null; const n = u.match(/\/maps\/place\/([^/@?]+)/);
  if (n) { try { name = decodeURIComponent(n[1].replace(/\+/g, " ")); } catch (e) {} }
  return { lat, lng, name };
}
// 從 Google 地圖網址取出「名稱＋地址」文字（新版 iPhone 分享連結只有 ?q=名稱,地址&ftid=…，沒有座標）
const junkQ = q => !q || /^[A-Za-z0-9_\-:.=+\/]{16,}$/.test(q.trim()) || /^(0x[0-9a-f]+|place_id:|ChIJ)/i.test(q.trim());
function mapQuery(u) {
  try {
    const x = new URL(u); const q = x.searchParams.get("q") || x.searchParams.get("query") || "";
    if (q && !junkQ(q) && !/^-?\d+\.\d+\s*,\s*-?\d+\.\d+$/.test(q)) return q;
    const p = x.pathname.match(/\/maps\/(?:place|search)\/([^/@]+)/); if (p) return decodeURIComponent(p[1].replace(/\+/g, " "));
  } catch (e) {}
  return "";
}
const placeName = q => String(q || "").split(/[,，]/)[0].split(/\s+(?=\d)/)[0].trim();
async function resolveMap(url, trace, ua) {
  let u = url, lastQ = "";
  for (let i = 0; i < 6; i++) {
    const hit = parseMapUrl(u); if (hit) { if (!hit.name && lastQ) hit.name = placeName(lastQ); return hit; }
    const q = mapQuery(u); if (q) lastQ = q;
    if (/consent\.google\./.test(u)) { try { const c = new URL(u).searchParams.get("continue"); if (c) { u = c; continue; } } catch (e) {} break; }
    if (!/^https:\/\/([a-z0-9-]+\.)*(goo\.gl|google\.[a-z.]+|g\.co)\//i.test(u)) break;
    let r; try { r = await fetch(u, { redirect: "manual", headers: { "User-Agent": ua || "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148", "Accept-Language": "zh-TW", "Cookie": "CONSENT=YES+" } }); } catch (e) { trace && trace.push({ u, err: String(e) }); break; }
    const loc = r.headers.get("location");
    if (trace) trace.push({ u: u.slice(0, 300), status: r.status, loc: loc && loc.slice(0, 300) });
    if (loc) { u = new URL(loc, u).toString(); continue; }
    const html = await r.text();
    if (trace) trace.push({ len: html.length, title: (html.match(/<title>([^<]*)/) || [])[1], og: (html.match(/og:title"[^>]*content="([^"]*)/) || html.match(/content="([^"]*)"[^>]*og:title/) || [])[1], center: (html.match(/center=[^&"]{0,40}/) || [])[0], url0: (html.match(/https:\/\/www\.google\.[a-z.]+\/maps\/[^"'\s\\]{0,200}/) || [])[0], nn: (html.match(/\[null,null,-?\d+\.\d+,-?\d+\.\d+\]/) || [])[0] });
    const m = html.match(/https:\/\/www\.google\.[a-z.]+\/maps\/[^"'\s\\]+/);
    if (m) { const hit2 = parseMapUrl(m[0].replace(/\\u0026/g, "&")); if (hit2) { if (!hit2.name && lastQ) hit2.name = placeName(lastQ); return hit2; } }
    // 注意：頁面裡的 center= 與 [null,null,lat,lng] 是依伺服器 IP 給的預設地圖中心，不是地點本身，不能用
    if (!lastQ) { const tt = (html.match(/<title>([^<]{2,120})<\/title>/) || [])[1] || ""; const nm = tt.replace(/\s*[-–|·]\s*Google.*$/i, "").replace(/&amp;/g, "&").trim(); if (nm && !/^Google/i.test(nm) && !junkQ(nm)) lastQ = nm; }
    break;
  }
  // 拿不到座標時，回傳名稱與地址，讓 App 再用地圖搜尋定位
  return lastQ ? { lat: null, lng: null, name: placeName(lastQ), q: lastQ } : null;
}

// 邀請連結：給 LINE 等 App 產生精美預覽卡片，再轉到旅帳
const OG_ISO = new Set("JP KR TH VN HK MO SG MY PH ID CN US GU PW CA GB FR DE IT ES NL AT PT GR FI BE IE HR CH SE AU NZ ZA TW".split(" "));
const escH = s => String(s || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function invitePage(u) {
  const q = u.searchParams; const t = (q.get("t") || "").replace(/[^a-z0-9]/gi, "").slice(0, 40);
  const n = (q.get("n") || "").slice(0, 40), by = (q.get("by") || "").slice(0, 20), d = (q.get("d") || "").slice(0, 20);
  const c = (q.get("c") || "").toUpperCase(); const img = APP_URL + "og/" + (OG_ISO.has(c) ? c : "default") + ".jpg";
  const app = APP_URL + "?" + new URLSearchParams({ n, by, c: OG_ISO.has(c) ? c : "", d }).toString() + (t ? "#trip-" + t : "");
  const title = by ? `${by} 邀請你加入「${n || "一起出發的旅程"}」` : `邀請你加入「${n || "一起出發的旅程"}」`;
  const desc = `${d ? d + "・" : ""}點開選一個可愛角色就能一起記帳，臺銀匯率自動換算、回國一鍵分帳。`;
  const html = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${escH(title)}｜旅帳</title><meta name="description" content="${escH(desc)}">
<meta property="og:type" content="website"><meta property="og:site_name" content="旅帳 TRAVEL LEDGER">
<meta property="og:title" content="${escH(title)}"><meta property="og:description" content="${escH(desc)}">
<meta property="og:image" content="${escH(img)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta property="og:url" content="${escH(u.toString())}"><meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#F6F1E7"><link rel="apple-touch-icon" href="${APP_URL}icons/apple-touch-icon.png">
<style>
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,"PingFang TC","Noto Sans TC",sans-serif;background:#F6F1E7;color:#2b2420;-webkit-font-smoothing:antialiased}
.w{max-width:460px;margin:0 auto;padding:calc(env(safe-area-inset-top) + 22px) 20px calc(env(safe-area-inset-bottom) + 28px)}
.br{display:flex;align-items:center;gap:10px;justify-content:center;margin-bottom:18px}.br img{width:34px;height:34px;border-radius:9px}.br b{font-family:"Noto Serif TC",serif;font-size:19px;letter-spacing:4px}
.cd{background:#fff;border-radius:24px;overflow:hidden;box-shadow:0 14px 40px rgba(0,0,0,.08);border:1px solid #ebe3d6}
.cd img{display:block;width:100%;aspect-ratio:1200/630;object-fit:cover;background:#efe7da}
.ct{padding:18px 20px 20px}.by{font-size:13px;color:#8a8076;letter-spacing:1px}.tt{font-size:22px;font-weight:800;line-height:1.35;margin:6px 0 4px}.dd{font-size:14px;color:#6c635a}
.st{list-style:none;padding:0;margin:20px 4px 0;display:grid;gap:12px}.st li{display:flex;gap:12px;align-items:center;font-size:15px}.st i{font-style:normal;flex:none;width:28px;height:28px;border-radius:50%;background:#16191b;color:#fff;display:grid;place-items:center;font-size:13px;font-weight:700}
.go{display:block;text-align:center;margin-top:24px;padding:17px;border-radius:16px;background:#16191b;color:#fff;text-decoration:none;font-size:17px;font-weight:700;letter-spacing:1px}
.nt{font-size:12.5px;color:#8a8076;text-align:center;margin-top:12px;line-height:1.7}
</style></head><body><div class="w">
<div class="br"><img src="${APP_URL}icons/icon-192.png" alt=""><b>旅帳</b></div>
<div class="cd"><img src="${escH(img)}" alt=""><div class="ct"><div class="by">${escH(by ? by + " 邀請你一起記帳" : "朋友邀請你一起記帳")}</div><div class="tt">${escH(n || "一起出發的旅程")}</div>${d ? `<div class="dd">📅 ${escH(d)}</div>` : ""}</div></div>
<ol class="st"><li><i>1</i>選一個可愛角色、輸入名字</li><li><i>2</i>選擇你是哪一位旅伴</li><li><i>3</i>開始一起記帳，回國一鍵分帳</li></ol>
<a class="go" href="${escH(app)}">加入旅程</a>
<div class="nt">不用註冊、完全免費<br>臺銀匯率自動換算，只有同一趟旅程的旅伴看得到帳目</div>
</div></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
}

// AI 排行程（Google Gemini）
const AI_MODELS = ["gemini-2.5-flash", "gemini-flash-lite-latest", "gemini-flash-latest"];
const AI_DAILY = 20;
async function gemini(env, reqBody, models, ms = 30000) {
  let lastErr = "";
  for (const m of models) {
    const c = new AbortController(); const tm = setTimeout(() => c.abort(), ms);
    try {
      let status, raw;
      if (env.GEMINI_RELAY) {
        const rr = await fetch(env.GEMINI_RELAY, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ model: m, key: env.GEMINI_KEY, body: reqBody }), signal: c.signal });
        const j = JSON.parse(await rr.text()); status = j.status; raw = j.body || "";
      } else {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_KEY }, body: JSON.stringify(reqBody), signal: c.signal });
        status = r.status; raw = await r.text();
      }
      if (status === 400 && /thinking/i.test(raw) && reqBody.generationConfig?.thinkingConfig) {
        const gc = { ...reqBody.generationConfig }; delete gc.thinkingConfig;
        const r2 = await gemini(env, { ...reqBody, generationConfig: gc }, [m], ms); if (r2.ok) return r2; lastErr += r2.err; continue;
      }
      if (status !== 200) { lastErr += `[${m} ${status} ${String(raw).slice(0, 160)}]`; continue; }
      const d = JSON.parse(raw); return { ok: true, text: d.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "" };
    } catch (e) { lastErr += `[${m} ${e.name === "AbortError" ? "timeout" : String(e.message || e).slice(0, 80)}]`; }
    finally { clearTimeout(tm); }
  }
  return { ok: false, err: lastErr };
}
// 航班 AI 帶入：航班號碼＋日期 → 起降機場、表定時間、航廈（先用 Google 搜尋查證，失敗才憑模型推測）
async function flightAI(b, uid, env, origin) {
  if (!env.GEMINI_KEY) return json({ error: "AI 未設定" }, 503, origin);
  const no = String(b.no || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(b.date || "") ? b.date : "";
  if (!/^[A-Z0-9]{2}\d{1,4}[A-Z]?$/.test(no)) return json({ error: "bad", detail: "航班號碼格式像 BR198、IT200" }, 400, origin);
  const day = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10), rk = `fl:${uid}:${day}`;
  const used = +(await env.PUSH.get(rk) || 0); if (used >= 30) return json({ error: "limit", detail: "今天的航班查詢次數已用完，明天再試" }, 429, origin);
  const wd = date ? new Date(date + "T00:00:00Z").getUTCDay() : -1;
  const ck = `flc:${no}:${wd}`; const hit = await env.PUSH.get(ck); if (hit) return json({ ok: true, cached: true, ...JSON.parse(hit) }, 200, origin);
  await env.PUSH.put(rk, String(used + 1), { expirationTtl: 90000 });
  const wdName = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][wd] || "";
  const ask = `Flight ${no}${date ? ` on ${date} (${wdName})` : ""}. Find its regular scheduled route and times.
Return ONLY a JSON object, no other text:
{"found":true|false,"airline":"airline name in Traditional Chinese if commonly known, else English","dep":"departure airport IATA code","arr":"arrival airport IATA code","depT":"scheduled departure local time HH:MM (24h)","arrT":"scheduled arrival local time HH:MM (24h)","arrNext":true|false (arrives the next calendar day),"depTerm":"departure terminal like T2, empty if unknown","arrTerm":"arrival terminal, empty if unknown"}
If the flight number does not exist or you are not reasonably sure of the route, return {"found":false}. Times must be local times at each airport.`;
  const pick = t => { try { const m = String(t || "").match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null; } catch { return null; } };
  let grounded = true;
  let r = await gemini(env, { contents: [{ parts: [{ text: ask }] }], tools: [{ google_search: {} }], generationConfig: { temperature: 0.1, maxOutputTokens: 700, thinkingConfig: { thinkingBudget: 0 } } }, ["gemini-2.5-flash", "gemini-flash-latest"], 30000);
  let o = r.ok ? pick(r.text) : null;
  if (!o) { grounded = false;
    r = await gemini(env, { contents: [{ parts: [{ text: ask }] }], generationConfig: { temperature: 0.1, maxOutputTokens: 500, responseMimeType: "application/json", thinkingConfig: { thinkingBudget: 0 } } }, ["gemini-2.5-flash", "gemini-flash-lite-latest", "gemini-flash-latest"], 25000);
    o = r.ok ? pick(r.text) : null; }
  if (!o) return json({ error: "ai", detail: (r.err || "AI 沒有回應").slice(0, 200) }, 502, origin);
  const ap = x => /^[A-Z]{3}$/.test(String(x || "").toUpperCase()) ? String(x).toUpperCase() : "";
  const tm = x => { const m = /^(\d{1,2}):(\d{2})/.exec(String(x || "")); return m && +m[1] < 24 && +m[2] < 60 ? `${m[1].padStart(2, "0")}:${m[2]}` : ""; };
  const out = { found: !!o.found && !!(ap(o.dep) && ap(o.arr)), airline: String(o.airline || "").slice(0, 30), dep: ap(o.dep), arr: ap(o.arr), depT: tm(o.depT), arrT: tm(o.arrT), arrNext: !!o.arrNext,
    depTerm: String(o.depTerm || "").slice(0, 12), arrTerm: String(o.arrTerm || "").slice(0, 12), grounded };
  if (out.found) await env.PUSH.put(ck, JSON.stringify(out), { expirationTtl: 7 * 86400 });
  return json({ ok: true, ...out }, 200, origin);
}
// 地點名稱辨識：中文俗稱、縮寫 → 當地正式名稱、英文名稱、地址、約略座標
async function placeAI(b, uid, env, origin) {
  if (!env.GEMINI_KEY) return json({ error: "AI 未設定" }, 503, origin);
  const q = String(b.q || "").slice(0, 200).trim(); if (!q) return json({ error: "empty" }, 400, origin);
  const day = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10), rk = `pl:${uid}:${day}`;
  const used = +(await env.PUSH.get(rk) || 0); if (used >= 80) return json({ error: "今天的智慧搜尋次數已用完" }, 429, origin);
  const ck = "plc:" + (b.country || "") + ":" + q.toLowerCase(); const hit = await env.PUSH.get(ck); if (hit) return json({ ok: true, cached: true, ...JSON.parse(hit) }, 200, origin);
  const prompt = `旅客在找一個地點，請判斷他指的是哪一個真實存在的地點（飯店、景點、餐廳、車站等）。
旅客輸入：「${q}」
旅行目的地：${String(b.country || "").slice(0, 20)}${b.cities?.length ? "（" + b.cities.slice(0, 5).map(x => String(x).slice(0, 20)).join("、") + "）" : ""}
旅客常用中文俗稱或縮寫，例如「那霸日航」= Hotel JAL City Naha（ホテルJALシティ那覇）。
請回傳最可能的 1 到 3 個候選，最可能的放第一個。只回傳真實存在的地點；完全無法判斷就回傳空陣列。
name_zh：台灣旅客熟悉的中文名稱；name_local：當地語言正式名稱；name_en：英文正式名稱；address：當地地址（英文或當地語言）；lat/lng：你所知的座標（盡量準確）；kind：hotel/sight/food/shop/transit/other。`;
  const schema = { type: "OBJECT", properties: { places: { type: "ARRAY", items: { type: "OBJECT", properties: { name_zh: { type: "STRING" }, name_local: { type: "STRING" }, name_en: { type: "STRING" }, address: { type: "STRING" }, lat: { type: "NUMBER" }, lng: { type: "NUMBER" }, kind: { type: "STRING" } }, required: ["name_zh", "name_en", "lat", "lng"] } } }, required: ["places"] };
  const r = await gemini(env, { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1, responseMimeType: "application/json", responseSchema: schema, thinkingConfig: { thinkingBudget: 0 } } }, ["gemini-2.5-flash", "gemini-flash-latest", "gemini-flash-lite-latest"], 25000);
  if (!r.ok) return json({ error: "AI 暫時無法回應", detail: r.err }, 502, origin);
  let out; try { out = JSON.parse(r.text); } catch (e) { return json({ error: "AI 回應格式錯誤" }, 502, origin); }
  const places = (out.places || []).filter(p => isFinite(p.lat) && isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180).slice(0, 3);
  await env.PUSH.put(rk, String(used + 1), { expirationTtl: 2 * 86400 });
  if (places.length) await env.PUSH.put(ck, JSON.stringify({ places }), { expirationTtl: 30 * 86400 });
  return json({ ok: true, places }, 200, origin);
}
async function aiPlan(b, uid, env, origin) {
  if (!env.GEMINI_KEY) return json({ error: "AI 功能還沒設定完成" }, 503, origin);
  const day = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10), rk = `ai:${uid}:${day}`;
  const used = +(await env.PUSH.get(rk) || 0);
  if (used >= AI_DAILY) return json({ error: `今天的 AI 排行程次數已用完（每天 ${AI_DAILY} 次），明天再試` }, 429, origin);
  const clip = (x, n) => String(x || "").slice(0, n);
  const days = (Array.isArray(b.days) ? b.days : []).slice(0, 7).map(d => ({ date: clip(d.date, 10), label: clip(d.label, 20), keep: (d.keep || []).slice(0, 15).map(k => ({ name: clip(k.name, 40), time: clip(k.time, 5) })) }));
  if (!days.length) return json({ error: "沒有要排的日期" }, 400, origin);
  const wish = (b.wish || []).slice(0, 30).map(w => ({ id: clip(w.id, 40), name: clip(w.name, 40) }));
  const CATS = ["sight", "food", "cafe", "shop", "transit", "hotel", "airport", "nature", "ticket", "night", "onsen", "other"];
  const prompt = `你是熟悉當地的旅遊規劃師，請用繁體中文（台灣用語）幫台灣旅客排行程。
目的地：${clip(b.country, 20)}${b.cities?.length ? "（" + b.cities.slice(0, 6).map(c => clip(c, 20)).join("、") + "）" : ""}
旅客人數：${+b.people || 2} 人
喜好：${(b.styles || []).slice(0, 8).map(x => clip(x, 10)).join("、") || "不限"}
步調：${clip(b.pace, 10) || "剛好"}（悠閒每天約 3–4 站、剛好 4–6 站、緊湊 6–8 站，含用餐）
每天活動時間：${clip(b.start, 5) || "09:00"} 到 ${clip(b.end, 5) || "21:00"}
住宿或出發區域：${clip(b.hotel, 60) || "未指定"}
旅客的其他需求（是喜好參考，請盡量照做；做不到的部分略過即可，但一定要照下面規則輸出完整行程，不要只回覆說明）：
<<<${clip(b.note, 200).replace(/[<>]/g, "") || "無"}>>>
想去清單（盡量排進去，用到時在 wishId 填它的 id）：${wish.length ? wish.map(w => `${w.id}=${w.name}`).join("；") : "無"}
要排的日期與已經排好、必須保留的行程（不要重複，新行程要避開這些時間）：
${days.map(d => `- ${d.date}${d.label ? " " + d.label : ""}：${d.keep.length ? d.keep.map(k => (k.time ? k.time + " " : "") + k.name).join("、") : "（空白）"}`).join("\n")}
規則：
0. 每一天都要有行程，date 只能用上面列出的日期（格式 YYYY-MM-DD）。
1. 只推薦真實存在、目前仍營業的知名地點，不要編造。
2. 同一天的地點要在相近區域，依順路排序，避免來回奔波；時間要考慮交通與停留。
3. 午餐約 11:30–13:30、晚餐約 17:30–19:30 各安排一個用餐地點（推薦當地特色店）。
4. name 用台灣旅客熟悉的中文名稱；query 用當地語言或英文的正式名稱加城市，方便在地圖上搜尋。
5. note 寫一句實用提醒（例如要預約、推薦點什麼、最佳時段），20 字以內。
6. stay 為停留分鐘數；cat 只能是：${CATS.join(", ")}。`;
  const schema = { type: "OBJECT", properties: { days: { type: "ARRAY", items: { type: "OBJECT", properties: { date: { type: "STRING", enum: days.map(d => d.date) }, items: { type: "ARRAY", items: { type: "OBJECT", properties: { time: { type: "STRING" }, name: { type: "STRING" }, query: { type: "STRING" }, cat: { type: "STRING", enum: CATS }, stay: { type: "INTEGER" }, note: { type: "STRING" }, wishId: { type: "STRING" } }, required: ["time", "name", "query", "cat", "stay"] } } }, required: ["date", "items"] } }, tip: { type: "STRING" } }, required: ["days"] };
  let lastErr = ""; const t0 = Date.now();
  const call = async (m, reqBody) => {
    const c = new AbortController(); const tm = setTimeout(() => c.abort(), 40000);
    try {
      if (env.GEMINI_RELAY) {
        // 透過 Google Apps Script 轉送，避免 Cloudflare 從不支援的地區（如香港）連線
        const rr = await fetch(env.GEMINI_RELAY, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ model: m, key: env.GEMINI_KEY, body: reqBody }), signal: c.signal });
        const rt = await rr.text(); try { const j = JSON.parse(rt); return { status: j.status, raw: j.body || "" }; } catch { return { status: 599, raw: "relay " + rr.status + " " + rt.slice(0, 120) }; }
      }
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_KEY }, body: JSON.stringify(reqBody), signal: c.signal });
      return { status: r.status, raw: await r.text() };
    } catch (e) { return { status: 598, raw: e.name === "AbortError" ? "timeout 40s" : String(e.message || e) }; }
    finally { clearTimeout(tm); }
  };
  for (const m of AI_MODELS) {
    if (Date.now() - t0 > 70000) break;
    const base = { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.7, maxOutputTokens: 8192, responseMimeType: "application/json", responseSchema: schema } };
    const fast = { ...base, generationConfig: { ...base.generationConfig, thinkingConfig: m.includes("2.5") ? { thinkingBudget: 0 } : { thinkingLevel: "low" } } };
    let { status, raw } = await call(m, fast);
    if (status === 400 && /thinking/i.test(raw)) ({ status, raw } = await call(m, base));
    if (status !== 200) { lastErr += `[${m} ${status} ${Math.round((Date.now() - t0) / 1000)}s ${raw.slice(0, 140)}] `; continue; }
    try {
      const d = JSON.parse(raw); const txt = d.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
      const out = JSON.parse(txt);
      // 日期對不上時依順序對應；完全沒有行程就換下一個模型重試
      const want = days.map(d => d.date);
      (out.days || []).forEach((d, i) => { if (!want.includes(d.date)) d.date = want[i] || want[0]; });
      const nItems = (out.days || []).reduce((a, d) => a + ((d.items || []).length), 0);
      if (!nItems) { lastErr += `[${m} empty]`; continue; }
      await env.PUSH.put(rk, String(used + 1), { expirationTtl: 2 * 86400 });
      return json({ ok: true, model: m, secs: Math.round((Date.now() - t0) / 1000), left: AI_DAILY - used - 1, ...out }, 200, origin);
    } catch (e) { lastErr += `[${m} parse ${String(e.message || e).slice(0, 80)}] `; }
  }
  return json({ error: "AI 暫時無法回應，請稍後再試", detail: lastErr }, 502, origin);
}

export default {
  async fetch(req, env) {
    loadKeys(env);
    const origin = req.headers.get("Origin") || "";
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
    const path = new URL(req.url).pathname;
    if (req.method === "GET" && path === "/weather") {
      const u = new URL(req.url); let lat = u.searchParams.get("lat"), lng = u.searchParams.get("lng");
      try {
        const cache = caches.default; const ck = new Request(req.url); const hit = await cache.match(ck); if (hit) { const r = new Response(hit.body, hit); Object.entries(cors(origin)).forEach(([k, v]) => r.headers.set(k, v)); return r; }
        if (!lat || !lng) { const q = u.searchParams.get("q"), cc = u.searchParams.get("cc") || "";
          let g = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&language=zh&name=${encodeURIComponent(q || "")}${cc ? `&countryCode=${cc}` : ""}`)).json();
          if (!g.results?.length && cc) g = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&language=zh&name=${encodeURIComponent(q || "")}`)).json();
          if (!g.results?.length) return json({ error: "place not found" }, 404, origin);
          lat = g.results[0].latitude; lng = g.results[0].longitude; }
        const f = await (await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=16`)).json();
        const res = new Response(JSON.stringify(f), { headers: { "content-type": "application/json", "Cache-Control": "public, max-age=1800", ...cors(origin) } });
        if (f.daily) await cache.put(ck, res.clone());
        return res;
      } catch (e) { return json({ error: String(e.message || e) }, 502, origin); }
    }
    if (req.method === "GET" && path === "/i") return invitePage(new URL(req.url));
    if (req.method === "GET" && path === "/ai-test") {
      // 診斷：逐一測試每個模型能不能回應（不會顯示金鑰）
      const out = { relay: !!env.GEMINI_RELAY, key: !!env.GEMINI_KEY, colo: req.cf && req.cf.colo, models: [] };
      for (const m of ["gemini-2.5-flash", "gemini-flash-latest", "gemini-flash-lite-latest"]) {
        const t0 = Date.now(); const r = await gemini(env, { contents: [{ role: "user", parts: [{ text: "只回答 OK" }] }], generationConfig: { maxOutputTokens: 20 } }, [m], 30000);
        out.models.push({ model: m, ok: r.ok, secs: ((Date.now() - t0) / 1000).toFixed(1), reply: r.ok ? r.text.slice(0, 20) : undefined, error: r.ok ? undefined : String(r.err).replace(/AIza[0-9A-Za-z_\-]+/g, "***").slice(0, 300) });
      }
      return new Response(JSON.stringify(out, null, 1), { headers: { "content-type": "application/json; charset=utf-8" } });
    }
    if (req.method === "GET" && path === "/flight-test") {
      // 診斷：航班 AI 帶入（Google 搜尋版、一般版各試一次，顯示原始回應或錯誤；不扣額度、不寫快取）
      const no = (new URL(req.url).searchParams.get("no") || "BR198").toUpperCase();
      const ask = `Flight ${no}. Return ONLY JSON {"found":true,"dep":"IATA","arr":"IATA","depT":"HH:MM","arrT":"HH:MM"}.`;
      const out = { relay: !!env.GEMINI_RELAY, tests: [] };
      for (const [name, body] of [["google_search", { contents: [{ parts: [{ text: ask }] }], tools: [{ google_search: {} }], generationConfig: { temperature: 0.1, maxOutputTokens: 400 } }],
                                  ["plain_json", { contents: [{ parts: [{ text: ask }] }], generationConfig: { temperature: 0.1, maxOutputTokens: 300, responseMimeType: "application/json" } }]]) {
        const t0 = Date.now(); const r = await gemini(env, body, ["gemini-2.5-flash"], 30000);
        out.tests.push({ name, ok: r.ok, secs: ((Date.now() - t0) / 1000).toFixed(1), reply: r.ok ? r.text.slice(0, 300) : undefined, error: r.ok ? undefined : String(r.err).replace(/AIza[0-9A-Za-z_\-]+/g, "***").slice(0, 400) });
      }
      return new Response(JSON.stringify(out, null, 1), { headers: { "content-type": "application/json; charset=utf-8" } });
    }
    if (req.method === "GET" && path === "/resolve-test") {
      const q = new URL(req.url).searchParams.get("u") || "";
      if (!/^https:\/\/(maps\.app\.goo\.gl|goo\.gl|maps\.google\.[a-z.]+|www\.google\.[a-z.]+)\//.test(q)) return json({ error: "only google maps links" }, 400, origin);
      const t1 = [], t2 = [];
      const r1 = await resolveMap(q, t1); const r2 = await resolveMap(q, t2, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36");
      return new Response(JSON.stringify({ iphone: { result: r1, trace: t1 }, desktop: { result: r2, trace: t2 }, colo: req.cf && req.cf.colo }, null, 1), { headers: { "content-type": "application/json; charset=utf-8" } });
    }
    if (req.method === "GET") return json({ ok: true, service: "旅帳推播", publicKey: VAPID_PUBLIC }, 200, origin);
    if (origin !== ALLOWED_ORIGIN) return json({ error: "origin" }, 403, origin);
    let b; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400, origin); }
    if (path === "/xfer-use") return xferUse(b, env, origin, req);
    if (path === "/xfer-new") return xferNew(b, env, origin);
    const uid = b.idToken ? await whoIs(b.idToken) : null;
    if (!uid) return json({ error: "請重新登入" }, 401, origin);

    if (path === "/ai-plan") return aiPlan(b, uid, env, origin);
    if (path === "/place-ai") return placeAI(b, uid, env, origin);
    if (path === "/flight-ai") return flightAI(b, uid, env, origin);
    if (path === "/subscribe") {
      const s = b.sub;
      if (!s?.endpoint || !s?.keys?.p256dh || !s?.keys?.auth) return json({ error: "bad subscription" }, 400, origin);
      const list = JSON.parse(await env.PUSH.get("u:" + uid) || "[]").filter(x => x.endpoint !== s.endpoint);
      list.unshift({ endpoint: s.endpoint, keys: s.keys, prefs: b.prefs || {}, ts: Date.now() });
      await env.PUSH.put("u:" + uid, JSON.stringify(list.slice(0, 5)));
      return json({ ok: true }, 200, origin);
    }
    if (path === "/unsubscribe") {
      const list = JSON.parse(await env.PUSH.get("u:" + uid) || "[]");
      const left = list.filter(x => x.endpoint !== b.endpoint);
      if (left.length !== list.length) await env.PUSH.put("u:" + uid, JSON.stringify(left));
      return json({ ok: true }, 200, origin);
    }
    if (path === "/notify") {
      const members = await tripMembers(b.idToken, b.tripId);
      if (!members || !members.includes(uid)) return json({ error: "not member" }, 403, origin);
      const type = String(b.type || "expense");
      const data = { title: String(b.title || "旅帳").slice(0, 60), body: String(b.body || "").slice(0, 180), url: APP_URL + "#trip-" + b.tripId, tag: b.tag ? String(b.tag).slice(0, 60) : undefined };
      let sent = 0;
      const targets = Array.isArray(b.to) ? members.filter(m => b.to.includes(m)) : members;
      await Promise.all(targets.filter(m => m !== uid).map(async m => {
        const list = JSON.parse(await env.PUSH.get("u:" + m) || "[]");
        const dead = [];
        await Promise.all(list.filter(s => s.prefs?.[type] !== false).map(async s => {
          try { const st = await sendPush(s, data); if (st === 404 || st === 410) dead.push(s.endpoint); else if (st < 300) sent++; } catch (e) {}
        }));
        if (dead.length) await env.PUSH.put("u:" + m, JSON.stringify(list.filter(s => !dead.includes(s.endpoint))));
      }));
      return json({ ok: true, sent }, 200, origin);
    }
    if (path === "/resolve") {
      const urls = (Array.isArray(b.urls) ? b.urls : [b.url]).filter(Boolean).slice(0, 20);
      const out = {};
      const DESK = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
      await Promise.all(urls.map(async u => { try { out[u] = await resolveMap(String(u)); } catch (e) { out[u] = null; } }));
      return json({ ok: true, geo: out }, 200, origin);
    }
    if (path === "/daily-test") {
      if (!env.FIREBASE_SA) return json({ error: "尚未設定 FIREBASE_SA" }, 500, origin);
      const members = await tripMembers(b.idToken, b.tripId);
      if (!members || !members.includes(uid)) return json({ error: "not member" }, 403, origin);
      try { return json({ ok: true, ...(await dailySummary(env, new Date(), b.tripId, uid)) }, 200, origin); }
      catch (e) { return json({ error: String(e.message || e) }, 500, origin); }
    }
    return json({ error: "not found" }, 404, origin);
  },
  async scheduled(event, env, ctx) {
    loadKeys(env);
    if (env.FIREBASE_SA) ctx.waitUntil(dailySummary(env).catch(e => console.log("daily", e)));
  }
};
