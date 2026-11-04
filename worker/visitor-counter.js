// Visitor counter, ratings and feedback, and app downloads for Nova Software Dev (nova) and Sibara Electrical
// (sibara). A free Cloudflare Worker with a D1 database. Version 3.
//
// Bindings (Worker > Settings > Bindings / Variables and Secrets):
//   DB          D1 database (any name)
//   OWNER_KEY   secret: your password; shows the numbers of every site and lets you remove reviews
//   SIBARA_KEY  secret (optional): a password for the Sibara site only, to give to its owner
//   GITHUB_TOKEN secret (optional): a GitHub fine-grained token with read-only "Contents" access to the
//               repositories that hold your installers. With it, installers in PRIVATE repositories can be
//               downloaded from the website (the code stays private). Public repositories work without it.
//
// Downloads: put the installer (.exe, .msi, .zip, .apk ...) on a GitHub Release of the app's repository.
// The website asks /release?repo=owner/name (is there a file? which version? how many downloads?) and its
// Download button goes to /download?repo=owner/name, which counts the download and hands over the file.
// Only repositories of GITHUB_OWNER (default eltonsibara1) are served.
//
// No cookies and no IP addresses are kept: a visitor is a one-way code that changes every day.
// Each site's numbers and reviews are kept apart by the "site" name the page sends.

const SITES = {
  nova: ["https://novasoftwaredev.netlify.app", "https://novasoftwaredev.co.za", "https://www.novasoftwaredev.co.za",
         "https://eltonsibara1.github.io"],
  sibara: ["https://sibaraelectric.com", "https://www.sibaraelectric.com", "https://eltonsibara1.github.io"],
};
const ALL = [...new Set(Object.values(SITES).flat())];
const VERSION = 3;
const GITHUB_OWNER_DEFAULT = "eltonsibara1";
const KINDS = [".exe", ".msi", ".msix", ".zip", ".apk", ".aab", ".dmg", ".appimage", ".deb", ".7z"];

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
  await db.exec("CREATE TABLE IF NOT EXISTS downloads (day TEXT, site TEXT, repo TEXT, version TEXT, file TEXT, " +
                "country TEXT, vid TEXT)");
  await db.exec("CREATE INDEX IF NOT EXISTS downloads_repo ON downloads(repo)");
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
    downloads: await rows(env, "SELECT repo AS name, COUNT(DISTINCT day || vid) AS n FROM downloads WHERE site = ? " +
                          "GROUP BY repo ORDER BY n DESC", site),
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

// ------------------------------------------------------------------ downloads from GitHub Releases
function repoOf(env, v) {
  const r = String(v || "").trim().replace(/^https:\/\/github\.com\//, "").replace(/\/+$/, "");
  const m = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(r);
  const owner = String(env.GITHUB_OWNER || GITHUB_OWNER_DEFAULT).toLowerCase();
  return m && m[1].toLowerCase() === owner ? r : "";
}

function gh(env, url, accept) {
  const h = { "User-Agent": "novasoftwaredev-downloads", "Accept": accept || "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28" };
  if (env.GITHUB_TOKEN) h["Authorization"] = "Bearer " + env.GITHUB_TOKEN;
  return fetch(url, { headers: h, redirect: "manual" });
}

// The newest release (pre-releases too, never drafts) that has an installer, cached for 5 minutes.
async function latest(env, repo) {
  const cache = caches.default;
  const key = new Request("https://cache.local/release/" + repo);
  const hit = await cache.match(key);
  if (hit) return await hit.json();
  let out = { available: false };
  const r = await gh(env, (env.GITHUB_API || "https://api.github.com") + "/repos/" + repo + "/releases?per_page=10");
  if (r.ok) {
    const list = await r.json();
    for (const rel of list) {
      if (rel.draft) continue;
      const files = (rel.assets || []).filter((a) => KINDS.some((k) => a.name.toLowerCase().endsWith(k)));
      files.sort((a, b) => KINDS.findIndex((k) => a.name.toLowerCase().endsWith(k)) -
                           KINDS.findIndex((k) => b.name.toLowerCase().endsWith(k)));
      if (files.length) {
        const f = files[0];
        out = { available: true, version: (rel.tag_name || rel.name || "").replace(/^v/i, ""), file: f.name,
                size: f.size, asset: f.url, published: (rel.published_at || "").slice(0, 10),
                prerelease: !!rel.prerelease };
        break;
      }
    }
  } else {
    out.reason = r.status === 404 ? "no repository or no access" : "GitHub said " + r.status;
  }
  await cache.put(key, new Response(JSON.stringify(out), { headers: { "Cache-Control": out.available ? "max-age=300" : "max-age=60" } }));
  return out;
}

async function downloadsOf(env, repo) {
  const r = (await rows(env, "SELECT COUNT(DISTINCT day || vid) AS n FROM downloads WHERE repo = ?", repo))[0];
  return (r && r.n) || 0;
}

async function release(req, env, url) {
  const repo = repoOf(env, url.searchParams.get("repo"));
  if (!repo) return json(req, { available: false, downloads: 0, reason: "not allowed" });
  const info = await latest(env, repo);
  const { asset, ...pub } = info;
  return json(req, { ...pub, downloads: await downloadsOf(env, repo) });
}

async function download(req, env, url) {
  const repo = repoOf(env, url.searchParams.get("repo"));
  const site = siteOf(url.searchParams.get("site"));
  const back = SITES[site][0];
  const info = repo ? await latest(env, repo) : { available: false };
  if (!info.available) {
    return new Response("<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'>" +
      "<title>Coming soon</title><body style='font:18px system-ui;padding:40px;text-align:center'>" +
      "<h1>Coming soon</h1><p>This download is not ready yet. Please check again later.</p>" +
      "<p><a href='" + back + "'>Back to the website</a></p>", { status: 404, headers: { "Content-Type": "text/html" } });
  }
  const r = await gh(env, info.asset, "application/octet-stream");
  const to = r.headers.get("Location");
  if (!to) return json(req, { error: "GitHub did not hand over the file (" + r.status + ")" }, 502);
  const ua = req.headers.get("User-Agent") || "";
  if (!/bot|crawl|spider|slurp|preview|headless/i.test(ua)) {
    const [day, vid] = await visitorId(req, env);
    await env.DB.prepare("INSERT INTO downloads (day, site, repo, version, file, country, vid) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(day, site, repo, info.version || "", info.file || "", (req.cf && req.cf.country) || "", vid).run();
  }
  return Response.redirect(to, 302);
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
      if (p === "/release") return await release(req, env, url);
      if (p === "/download") return await download(req, env, url);
      return json(req, { ok: true, name: "visitor counter", version: VERSION });
    } catch (e) {
      return json(req, { error: String(e && e.message || e) }, 500);
    }
  },
};
