// Visitor counter + ratings and feedback for Nova Software Dev (novasoftwaredev) and Sibara Electrical (sibara).
// A free Cloudflare Worker with a D1 database. Version 2.
//
// Bindings (Worker > Settings > Bindings / Variables and Secrets):
//   DB          D1 database (any name)
//   OWNER_KEY   secret: your password; shows the numbers of every site and lets you remove reviews
//   SIBARA_KEY  secret (optional): a password for the Sibara site only, to give to its owner
//
// No cookies and no IP addresses are kept: a visitor is a one-way code that changes every day.
// Each site's numbers and reviews are kept apart by the "site" name the page sends.

const SITES = {
  nova: ["https://novasoftwaredev.netlify.app", "https://novasoftwaredev.co.za", "https://www.novasoftwaredev.co.za",
         "https://eltonsibara1.github.io"],
  sibara: ["https://sibaraelectric.com", "https://www.sibaraelectric.com", "https://eltonsibara1.github.io"],
};
const ALL = [...new Set(Object.values(SITES).flat())];
const VERSION = 2;

function cors(req) {
  const o = req.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin": ALL.includes(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o) ? o : ALL[0],
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function json(req, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors(req) },
  });
}

function siteOf(v) {
  v = String(v || "nova").toLowerCase();
  return v in SITES ? v : "nova";
}

async function setup(db) {
  await db.exec("CREATE TABLE IF NOT EXISTS views (day TEXT, path TEXT, country TEXT, device TEXT, ref TEXT, vid TEXT)");
  await db.exec("CREATE INDEX IF NOT EXISTS views_day ON views(day)");
  try { await db.exec("ALTER TABLE views ADD COLUMN site TEXT DEFAULT 'nova'"); } catch (e) {}   // version 1 had no site
  await db.exec("CREATE TABLE IF NOT EXISTS reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, site TEXT, target TEXT, " +
                "stars INTEGER, name TEXT, role TEXT, text TEXT, day TEXT, vid TEXT, hidden INTEGER DEFAULT 0)");
  await db.exec("CREATE INDEX IF NOT EXISTS reviews_site ON reviews(site)");
}

async function sha(text) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(b)].slice(0, 8).map((x) => x.toString(16).padStart(2, "0")).join("");
}

function device(ua) {
  if (/iPad|Tablet/i.test(ua)) return "Tablet";
  if (/Mobi|Android|iPhone/i.test(ua)) return "Phone";
  return "Computer";
}

async function visitorId(req, env) {
  const day = new Date().toISOString().slice(0, 10);
  const ip = req.headers.get("CF-Connecting-IP") || "";
  const ua = req.headers.get("User-Agent") || "";
  return [day, await sha(day + ip + ua + (env.OWNER_KEY || ""))];
}

async function body(req) {
  try { return JSON.parse(await req.text()); } catch (e) { return {}; }
}

function clean(s, max) {
  return String(s == null ? "" : s).replace(/[\u0000-\u0008\u000b-\u001f]/g, "").trim().slice(0, max);
}

function ownerOf(env, site, key) {
  if (!key) return false;
  if (env.OWNER_KEY && key === env.OWNER_KEY) return true;
  return site === "sibara" && !!env.SIBARA_KEY && key === env.SIBARA_KEY;
}

async function hit(req, env) {
  const ua = req.headers.get("User-Agent") || "";
  if (/bot|crawl|spider|slurp|preview|lighthouse|headless/i.test(ua)) return json(req, { ok: true, skipped: true });
  const b = await body(req);
  const site = siteOf(b.site);
  const [day, vid] = await visitorId(req, env);
  const path = String(b.path || "/").slice(0, 120);
  let ref = "";
  try { ref = b.ref ? new URL(b.ref).hostname.replace(/^www\./, "") : ""; } catch (e) {}
  if (SITES[site].some((s) => ref && s.includes(ref))) ref = "";
  await env.DB.prepare("INSERT INTO views (day, path, country, device, ref, vid, site) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(day, path, (req.cf && req.cf.country) || "", device(ua), ref, vid, site).run();
  return json(req, { ok: true });
}

async function rows(env, sql, ...args) {
  return (await env.DB.prepare(sql).bind(...args).all()).results;
}

async function stats(req, env, url) {
  const site = siteOf(url.searchParams.get("site"));
  if (!ownerOf(env, site, url.searchParams.get("key"))) return json(req, { error: "key" }, 403);
  const d = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const today = d(0), d7 = d(6), d30 = d(29);
  const S = "COALESCE(site, 'nova') = ?";
  const one = async (sql, ...a) => (await rows(env, sql, ...a))[0] || {};
  const count = "SELECT COUNT(*) AS views, COUNT(DISTINCT day || vid) AS visitors FROM views WHERE " + S;
  return json(req, {
    site,
    today: await one(count + " AND day = ?", site, today),
    week: await one(count + " AND day >= ?", site, d7),
    month: await one(count + " AND day >= ?", site, d30),
    total: await one(count, site),
    days: await rows(env, "SELECT day, COUNT(*) AS views, COUNT(DISTINCT vid) AS visitors FROM views WHERE " + S +
                     " AND day >= ? GROUP BY day ORDER BY day", site, d30),
    pages: await rows(env, "SELECT path AS name, COUNT(*) AS n FROM views WHERE " + S +
                      " AND day >= ? GROUP BY path ORDER BY n DESC LIMIT 10", site, d30),
    countries: await rows(env, "SELECT country AS name, COUNT(DISTINCT day || vid) AS n FROM views WHERE " + S +
                          " AND day >= ? GROUP BY country ORDER BY n DESC LIMIT 10", site, d30),
    devices: await rows(env, "SELECT device AS name, COUNT(DISTINCT day || vid) AS n FROM views WHERE " + S +
                        " AND day >= ? GROUP BY device ORDER BY n DESC", site, d30),
    from: await rows(env, "SELECT ref AS name, COUNT(*) AS n FROM views WHERE " + S +
                     " AND day >= ? AND ref != '' GROUP BY ref ORDER BY n DESC LIMIT 10", site, d30),
  });
}

async function listReviews(req, env, url) {
  const site = siteOf(url.searchParams.get("site"));
  const list = await rows(env, "SELECT id, target, stars, name, role, text, day AS date FROM reviews " +
                               "WHERE site = ? AND hidden = 0 ORDER BY id DESC LIMIT 500", site);
  return json(req, { ok: true, reviews: list });
}

async function addReview(req, env) {
  const b = await body(req);
  if (b.website) return json(req, { ok: true });                 // a field only robots fill in
  const site = siteOf(b.site);
  const target = clean(b.target || "site", 120);
  const stars = Math.round(Number(b.stars || 0));
  const name = clean(b.name, 60), role = clean(b.role, 80), text = clean(b.text, 1000);
  if (!(stars >= 0 && stars <= 5)) return json(req, { ok: false, error: "Pick 1 to 5 stars" }, 400);
  if (!stars && !text) return json(req, { ok: false, error: "Write something first" }, 400);
  if (!name) return json(req, { ok: false, error: "Type your name" }, 400);
  const [day, vid] = await visitorId(req, env);
  const n = (await rows(env, "SELECT COUNT(*) AS n FROM reviews WHERE vid = ? AND day = ?", vid, day))[0].n;
  if (n >= 6) return json(req, { ok: false, error: "Thank you! That is enough for today." }, 429);
  const r = await env.DB.prepare("INSERT INTO reviews (site, target, stars, name, role, text, day, vid) " +
                                 "VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(site, target, stars, name, role, text, day, vid).run();
  return json(req, { ok: true, review: { id: r.meta && r.meta.last_row_id, target, stars, name, role, text, date: day } });
}

async function hideReview(req, env) {
  const b = await body(req);
  const site = siteOf(b.site);
  if (!ownerOf(env, site, b.key)) return json(req, { error: "key" }, 403);
  await env.DB.prepare("UPDATE reviews SET hidden = 1 WHERE id = ? AND site = ?").bind(Number(b.id), site).run();
  return json(req, { ok: true });
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: cors(req) });
    if (!env.DB) return json(req, { error: "The Worker has no D1 database called DB yet (Settings > Bindings)." }, 500);
    const url = new URL(req.url);
    try {
      await setup(env.DB);
      const p = url.pathname;
      if (p === "/hit" && req.method === "POST") return await hit(req, env);
      if (p === "/count") {
        const site = siteOf(url.searchParams.get("site"));
        const r = (await rows(env, "SELECT COUNT(DISTINCT day || vid) AS visitors FROM views " +
                                   "WHERE COALESCE(site, 'nova') = ?", site))[0] || {};
        return json(req, { visitors: r.visitors || 0, site, version: VERSION });
      }
      if (p === "/stats") return await stats(req, env, url);
      if (p === "/reviews" && req.method === "GET") return await listReviews(req, env, url);
      if (p === "/review" && req.method === "POST") return await addReview(req, env);
      if (p === "/review/hide" && req.method === "POST") return await hideReview(req, env);
      return json(req, { ok: true, name: "visitor counter", version: VERSION });
    } catch (e) {
      return json(req, { error: String(e && e.message || e) }, 500);
    }
  },
};
