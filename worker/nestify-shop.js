// Nestify shop: buying Nestify on novasoftwaredev.co.za through Paystack, and the unlock codes.
// A Cloudflare Worker with a D1 database. Version 2 (Paystack).
//
// Bindings (Worker > Settings > Bindings / Variables and Secrets) - typed in Cloudflare, never in a file:
//   DB                   D1 database (can be the same one as the visitor counter; this Worker makes its own tables)
//   UNLOCK_KEY           secret: the key Nestify's codes are made with (the KEY in your private
//                        tools/unlock_phone.html, the long hex text between the quotes)
//   PAYSTACK_SECRET_KEY  secret: Paystack dashboard > Settings > API Keys & Webhooks > Secret key.
//                        Use the TEST key (sk_test_...) while testing, then the live key (sk_live_...)
//   OWNER_KEY            secret (optional): your password for /orders (a list of the sales)
//
// Paystack dashboard > Settings > API Keys & Webhooks > Webhook URL:
//   https://<this Worker's address>/paystack/webhook
//
// How it works
//   1. The website's Buy page sends the Computer ID(s), the plan, month / year and the buyer's email to POST /pay.
//   2. This Worker works out the price HERE (the page cannot change it), starts a Paystack transaction and answers
//      with Paystack's payment page address. The page sends the buyer there (card or bank, as Paystack offers).
//   3. Paystack tells this Worker the result at POST /paystack/webhook. The message is checked with the signature,
//      then the transaction is checked again with Paystack's verify call (status and amount). When it is paid, the
//      code is made: the plan, until when (a renewal adds the month or year to the date the last code ran to), for
//      that computer only.
//   4. The buyer comes back to the website, which shows the code (GET /order?ref=...). Nestify can also fetch the
//      newest code of its own computer (GET /licence?id=...): a code only works on the computer it was made for,
//      so knowing it is no use to anyone else. That is how monthly renewals unlock without typing.

const ORIGINS = ["https://novasoftwaredev.co.za", "https://www.novasoftwaredev.co.za", "https://eltonsibara1.github.io",
                 "http://localhost:8000"];
const PRICES = {home: {month: 149, year: 1490}, pro: {month: 399, year: 3990}, office: {month: 999, year: 9990}};
const NAMES = {home: "Home", pro: "Pro", office: "Office"};
const LETTER = {home: "H", pro: "P", office: "O"};
const A32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const SITE = "https://novasoftwaredev.co.za";
const PAYSTACK = "https://api.paystack.co";

function cors(req) {
  const o = req.headers.get("Origin") || "";
  return {"Access-Control-Allow-Origin": ORIGINS.includes(o) ? o : ORIGINS[0], "Vary": "Origin",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type"};
}
function json(req, data, status = 200) {
  return new Response(JSON.stringify(data), {status, headers: {"Content-Type": "application/json", ...cors(req)}});
}

// ------------------------------------------------------------------ codes (the same as Nestify's licence.py)
function clean(t) {
  return String(t || "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/0/g, "O").replace(/1/g, "I").replace(/8/g, "B");
}
function groups(s) { return s.match(/.{1,5}/g).join("-"); }
function b32(bytes, n) {
  let bits = 0, v = 0, s = "";
  for (const b of bytes) { v = (v << 8) | b; bits += 8; while (bits >= 5) { s += A32[(v >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) s += A32[(v << (5 - bits)) & 31];
  return s.slice(0, n);
}
function hexBytes(h) { const a = new Uint8Array(h.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16); return a; }
async function hmac(keyHex, msg) {
  const k = await crypto.subtle.importKey("raw", hexBytes(keyHex.trim()), {name: "HMAC", hash: "SHA-256"}, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg)));
}
const EPOCH = Date.UTC(2025, 0, 1);
function dayNumber(d) { return Math.round((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - EPOCH) / 864e5); }
async function planCode(env, cid, plan, lastDay) {        // lastDay: a Date (UTC), or null for no end
  const n = lastDay ? dayNumber(lastDay) : 0;
  const head = LETTER[plan] + A32[(n >> 10) & 31] + A32[(n >> 5) & 31] + A32[n & 31];
  return groups(head + b32(await hmac(env.UNLOCK_KEY, "nestify-plan:" + clean(cid) + ":" + head), 16));
}
function addMonths(d, n) {
  const r = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const last = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
  r.setUTCDate(Math.min(d.getUTCDate(), last));
  return r;
}
function isoDay(d) { return d.toISOString().slice(0, 10); }

// ------------------------------------------------------------------ Paystack
async function hmacHex512(key, msg) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), {name: "HMAC", hash: "SHA-512"}, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg)));
  return [...sig].map(b => b.toString(16).padStart(2, "0")).join("");
}
function sameText(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function paystackHeaders(env) {
  return {Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`, "Content-Type": "application/json", Accept: "application/json"};
}

async function schema(env) {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS shop_orders (ref TEXT PRIMARY KEY, ids TEXT, plan TEXT, term TEXT,
      amount TEXT, status TEXT, created INTEGER, paid INTEGER, codes TEXT, txn TEXT, email TEXT)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS shop_licences (id TEXT PRIMARY KEY, plan TEXT, last_day TEXT,
      code TEXT, updated INTEGER)`),
  ]);
}

async function pay(req, env) {
  const b = await req.json().catch(() => ({}));
  const plan = String(b.plan || ""), term = String(b.term || "");
  if (!PRICES[plan] || !PRICES[plan][term]) return json(req, {error: "Choose a plan and month or year."}, 400);
  let ids = (Array.isArray(b.ids) ? b.ids : [b.id]).map(clean).filter(x => x.length === 10);
  ids = [...new Set(ids)].slice(0, plan === "office" ? 3 : 1);
  if (!ids.length) return json(req, {error: "Type the Computer ID from Nestify (Help > Your plan), like K7QXM-2RDTA."}, 400);
  const email = String(b.email || "").trim().slice(0, 120);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    return json(req, {error: "Type your email address. Paystack sends the receipt there."}, 400);
  if (!env.PAYSTACK_SECRET_KEY || !env.UNLOCK_KEY)
    return json(req, {error: "Buying is not open yet. Please try again later."}, 503);
  await schema(env);
  const price = PRICES[plan][term];
  const amount = price.toFixed(2);
  const ref = "NST" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();
  await env.DB.prepare("INSERT INTO shop_orders (ref, ids, plan, term, amount, status, created, email) VALUES (?,?,?,?,?,?,?,?)")
    .bind(ref, ids.map(groups).join(","), plan, term, amount, "sent", Date.now(), email).run();
  const back = `${SITE}/#app/nestify/get?ref=${ref}`;
  const r = await fetch(`${PAYSTACK}/transaction/initialize`, {method: "POST", headers: paystackHeaders(env),
    body: JSON.stringify({email, amount: Math.round(price * 100), currency: "ZAR", reference: ref, callback_url: back,
      metadata: {product: "Nestify", plan: NAMES[plan], term, ids: ids.map(groups).join(",")}})});
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.status || !d.data || !d.data.authorization_url) {
    await env.DB.prepare("UPDATE shop_orders SET status = 'failed' WHERE ref = ?").bind(ref).run();
    return json(req, {error: "Could not start the payment. Please try again."}, 502);
  }
  return json(req, {ref, authorization_url: d.data.authorization_url, amount, plan: NAMES[plan], term});
}

// Paystack calls this when something happens to a payment. The signature proves it came from Paystack.
async function webhook(req, env) {
  const raw = await req.text();
  const want = await hmacHex512(env.PAYSTACK_SECRET_KEY || "", raw);
  if (!sameText(want, req.headers.get("x-paystack-signature") || "")) return new Response("bad signature", {status: 400});
  const ev = JSON.parse(raw);
  const ref = ev && ev.data && ev.data.reference;
  if (!ref) return new Response("ok");
  if (ev.event === "charge.success") return await settle(env, ref);
  if (ev.event === "charge.failed") {
    await schema(env);
    await env.DB.prepare("UPDATE shop_orders SET status = 'failed' WHERE ref = ? AND status != 'paid'").bind(ref).run();
  }
  return new Response("ok");
}

// Check the payment with Paystack itself before any code is made.
async function settle(env, ref) {
  await schema(env);
  const o = await env.DB.prepare("SELECT * FROM shop_orders WHERE ref = ?").bind(ref).first();
  if (!o) return new Response("no such order", {status: 404});
  if (o.status === "paid") return new Response("ok");                 // told twice: once is enough
  const r = await fetch(`${PAYSTACK}/transaction/verify/${encodeURIComponent(ref)}`, {headers: paystackHeaders(env)});
  const d = await r.json().catch(() => ({}));
  const t = d && d.data;
  if (!r.ok || !d.status || !t || t.status !== "success") return new Response("not successful", {status: 400});
  if (t.currency !== "ZAR" || Number(t.amount) !== Math.round(Number(o.amount) * 100))
    return new Response("wrong amount", {status: 400});
  const codes = [];
  for (const id of o.ids.split(",")) {
    const cur = await env.DB.prepare("SELECT * FROM shop_licences WHERE id = ?").bind(id).first();
    let start = new Date();
    if (cur && cur.plan === o.plan && cur.last_day && new Date(cur.last_day + "T00:00:00Z") > start)
      start = new Date(cur.last_day + "T00:00:00Z");                 // a renewal adds on to the paid time
    const last = addMonths(start, o.term === "year" ? 12 : 1);
    const code = await planCode(env, id, o.plan, last);
    await env.DB.prepare(`INSERT INTO shop_licences (id, plan, last_day, code, updated) VALUES (?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET plan = excluded.plan, last_day = excluded.last_day, code = excluded.code,
      updated = excluded.updated`).bind(id, o.plan, isoDay(last), code, Date.now()).run();
    codes.push({id, code, last_day: isoDay(last)});
  }
  await env.DB.prepare("UPDATE shop_orders SET status = 'paid', paid = ?, codes = ?, txn = ? WHERE ref = ?")
    .bind(Date.now(), JSON.stringify(codes), String(t.id || ""), ref).run();
  return new Response("ok");
}

async function order(req, env, url) {
  await schema(env);
  const o = await env.DB.prepare("SELECT ref, plan, term, amount, status, codes FROM shop_orders WHERE ref = ?")
    .bind(url.searchParams.get("ref") || "").first();
  if (!o) return json(req, {error: "No such order."}, 404);
  return json(req, {ref: o.ref, plan: NAMES[o.plan], term: o.term, amount: o.amount, status: o.status,
                    codes: o.status === "paid" ? JSON.parse(o.codes || "[]") : []});
}

async function licence(req, env, url) {
  await schema(env);
  const raw = clean(url.searchParams.get("id") || "");
  if (raw.length !== 10) return json(req, {error: "Not a Computer ID."}, 400);
  const id = groups(raw);
  const l = await env.DB.prepare("SELECT plan, last_day, code FROM shop_licences WHERE id = ?").bind(id).first();
  return json(req, l ? {plan: l.plan, last_day: l.last_day, code: l.code} : {});
}

async function orders(req, env, url) {
  if (!env.OWNER_KEY || url.searchParams.get("key") !== env.OWNER_KEY) return json(req, {error: "no"}, 403);
  await schema(env);
  const r = await env.DB.prepare("SELECT ref, ids, plan, term, amount, status, created, paid, email FROM shop_orders ORDER BY created DESC LIMIT 200").all();
  return json(req, r.results || []);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, {headers: cors(req)});
    try {
      if (url.pathname === "/pay" && req.method === "POST") return await pay(req, env);
      if (url.pathname === "/paystack/webhook" && req.method === "POST") return await webhook(req, env);
      if (url.pathname === "/order") return await order(req, env, url);
      if (url.pathname === "/licence") return await licence(req, env, url);
      if (url.pathname === "/orders") return await orders(req, env, url);
      if (url.pathname === "/") return json(req, {shop: "nestify", version: 2, open: !!(env.PAYSTACK_SECRET_KEY && env.UNLOCK_KEY)});
    } catch (e) {
      return json(req, {error: "Something went wrong: " + e.message}, 500);
    }
    return json(req, {error: "not found"}, 404);
  },
};
