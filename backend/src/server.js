// WatchBack — accounts API.
// Endpoints:
//   GET  /api/health
//   POST /api/signup           { email, password }  -> { token, user }
//   POST /api/login            { email, password }  -> { token, user }
//   GET  /api/me               (Bearer token)       -> { user }
//   GET  /api/competitors      (Bearer token)       -> { competitors }
//   POST /api/competitors      { name, host, url }  -> { competitor }
//   DELETE /api/competitors/:id

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { initSchema, pool } from './db.js';
import { signup, login, requireAuth, optionalUid, JWT_IS_DEFAULT } from './auth.js';
import { fetchAds, adsChanges } from './ads.js';
import { fetchSocial, resolveHandles } from './social.js';
import { startScheduler, warmStatus, addTracked, removeTracked, getTracked, warmBrand, allBrands } from './refresh.js';
import { postDigest, postText } from './slack.js';
import { storeInbound, getEmails, recentEmails, getEmailHtml } from './email.js';
import { chat } from './chat.js';
import { websiteCompare } from './website.js';
import { getInsights, quickAngle, creditStatus } from './insights.js';
import { getMyBrand, setMyBrand, clearMyBrand } from './brand.js';
import { storeFeedback, listFeedback } from './feedback.js';
import { systemStats } from './stats.js';
import { getWeekly } from './weekly.js';
import { snapshotDays, snapshotForDay, recentSnapshots } from './snapshots.js';

const app = express();
// Emails can be large; also accept form-encoded posts from inbound-email services.
app.use(express.json({ limit: '3mb' }));
app.use(express.urlencoded({ extended: true, limit: '3mb' }));

// Only your site(s) may call the API. Set ALLOWED_ORIGIN in Railway, e.g.
//   https://marinbando-afk.github.io
const allowed = (process.env.ALLOWED_ORIGIN || '*').split(',').map((s) => s.trim());
app.use(cors({ origin: allowed.includes('*') ? true : allowed }));

// ── Per-IP rate limiting (in-memory, no external deps) ─────────────────────────
// Guards the cost-bearing AI/scrape endpoints from runaway use or abuse. Each
// limiter keeps its own sliding window and returns 429 + Retry-After when tripped.
function rateLimit(max, windowMs) {
  const hits = new Map();
  return (req, res, next) => {
    const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'x').split(',')[0].trim();
    const now = Date.now();
    let e = hits.get(ip);
    if (!e || now - e.start >= windowMs) { e = { start: now, n: 0 }; hits.set(ip, e); }
    if (++e.n > max) {
      res.set('Retry-After', String(Math.ceil((e.start + windowMs - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests — please slow down a moment.' });
    }
    if (hits.size > 5000) for (const [k, v] of hits) if (now - v.start > windowMs) hits.delete(k);
    next();
  };
}
// Generous global ceiling — normal use is far under this; the Claude-backed
// endpoints (chat/angle/shot) get a tighter shared cap applied at their routes.
app.use('/api/', rateLimit(200, 60000));
const aiLimit = rateLimit(30, 60000);

app.get('/api/health', async (req, res) => {
  let userTracked = null;
  try { userTracked = (await getTracked()).length; } catch (e) { /* db optional */ }
  res.json({ ok: true, ...warmStatus(), userTracked });
});

// Real capture counts for the landing page's proof band (never invented — see stats.js).
app.get('/api/stats', async (req, res) => {
  try { res.json(await systemStats()); } catch (e) { res.json({ available: false }); }
});

// Weekly intelligence report (shareable page: report.html?host=…).
app.get('/api/weekly', async (req, res) => {
  try { res.json({ report: await getWeekly(req.query.host, req.query.week || null) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Ads intelligence — a competitor's live ads from the Meta Ad Library (via Apify).
//   GET /api/ads?brand=The%20Oodie&country=AU  -> { count, ads: [{ text, image, page, started, link }] }
app.get('/api/ads', async (req, res) => {
  try {
    // One competitor = one dataset. If this host is already tracked (by any customer or
    // as a demo), scrape under its CANONICAL name + country — so two customers who typed
    // slightly different names for the same competitor share one cache entry (the same
    // one the nightly warm keeps hot) instead of triggering duplicate Apify scrapes.
    let brand = req.query.brand, country = req.query.country;
    const qh = String(req.query.host || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '').toLowerCase();
    if (qh) {
      try {
        const t = (await allBrands()).find((b) => b.host === qh);
        if (t) { brand = t.name; country = t.country; }
      } catch (e) { /* canonicalization is best-effort */ }
    }
    const data = await fetchAds(brand, country, req.query.force === '1');
    const out = { active: data.active, newest: data.newest, platforms: data.platforms, country: data.country, ads: (data.ads || []).slice(0, 30) };
    if (req.query.host) {
      try {
        const ch = await adsChanges(req.query.host, data.ads);
        if (ch) {
          out.newCount = ch.newCount; out.baseline = ch.baseline; out.signals = ch.signals;
          // Show the new ads when there are any; otherwise show current creatives so the section is never empty.
          out.ads = (ch.newCount > 0) ? ch.newAds : (data.ads || []).slice(0, 24);
        }
      } catch (e) { /* fall back to the trimmed full list */ }
    }
    res.json(out);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Organic social — a competitor's recent posts on one platform (via Apify).
//   GET /api/social?platform=instagram&handle=the_oodie
//   GET /api/social?platform=tiktok&host=theoodie.com   (handle auto-resolved)
app.get('/api/social', async (req, res) => {
  try {
    const platform = req.query.platform;
    const live = await fetchSocial(platform, req.query.handle, req.query.host);
    // Live scrape came back empty (flaky platform, rate limit, etc.). Fall back to the last
    // capture that DID have posts, flagged stale — so the panel shows real content ("no recent
    // posts, showing last captured") instead of a dead end. Snapshots are only saved when
    // posts existed, so this stays empty for profiles that genuinely never yielded any.
    if ((!live || !live.posts || !live.posts.length) && req.query.host && platform) {
      try {
        const host = String(req.query.host).replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '').toLowerCase();
        const rows = await recentSnapshots(host, platform, 1);
        const snap = rows[0] && rows[0].data;
        if (snap && snap.posts && snap.posts.length) {
          return res.json({ handle: snap.handle || (live && live.handle) || req.query.handle || '', posts: snap.posts, summary: snap.summary, stale: true, staleDay: rows[0].day });
        }
      } catch (e) { /* fallback is best-effort */ }
    }
    res.json(live);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Detect a competitor's social handles from their website — powers the "confirm
// their pages" step when a user adds a competitor.
app.get('/api/resolve-handles', async (req, res) => {
  try {
    const host = String(req.query.host || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '').toLowerCase();
    if (!host) return res.status(400).json({ error: 'Missing host.' });
    res.json({ host, handles: await resolveHandles(host) });
  } catch (e) { res.json({ host: '', handles: {} }); }
});

// Email intelligence (seeded inbox).
//   POST /api/inbound-email  — the inbound service posts each received email here.
//   GET  /api/emails?host=theoodie.com  -> { emails, summary }
app.post('/api/inbound-email', async (req, res) => {
  if (process.env.INBOUND_KEY && req.query.key !== process.env.INBOUND_KEY) {
    return res.status(403).json({ error: 'forbidden' });
  }
  try {
    res.json(await storeInbound(req.body));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get('/api/emails', async (req, res) => {
  try {
    res.json(await getEmails(req.query.host));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get('/api/emails-recent', async (req, res) => {
  try {
    res.json(await recentEmails());
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Full HTML of one captured email — for the in-app email preview.
app.get('/api/email-html', async (req, res) => {
  try {
    const r = await getEmailHtml(req.query.id);
    if (!r) return res.status(404).json({ error: 'not found' });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// AI chat — answer a question grounded in a competitor's captured data.
app.post('/api/chat', aiLimit, async (req, res) => {
  try {
    res.json(await chat(req.body, optionalUid(req)));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// History — the days we have snapshots for, and one day's full snapshot.
app.get('/api/history', async (req, res) => {
  try {
    res.json({ days: await snapshotDays(req.query.host) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get('/api/snapshot', async (req, res) => {
  try {
    res.json({ day: req.query.day, channels: await snapshotForDay(req.query.host, req.query.day) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Website change detection — before/after screenshots + a list of what changed
// since the previous captured day.
app.get('/api/website-compare', async (req, res) => {
  try {
    res.json(await websiteCompare(req.query.host, req.query.url, req.query.day));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// AI insights — per-channel, context-aware read (cached daily, generated on demand).
app.get('/api/insights', async (req, res) => {
  try {
    res.json({ insights: await getInsights(req.query.host, req.query.name, req.query.refresh === '1', optionalUid(req)) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// One-line marketing angle (+ how YOUR brand could apply it) for a single ad/post.
// Quick Anthropic balance probe (cached ~5 min) — so I can check if AI credits ran dry.
app.get('/api/credits', async (req, res) => { res.json(await creditStatus(req.query.fresh === '1')); });
// Send the Slack daily brief now (on-demand / for testing). Posts only to your SLACK_WEBHOOK_URL.
app.get('/api/slack-test', async (req, res) => {
  if (!process.env.ADMIN_KEY || req.query.key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Owner key required.' });
  res.json(await postDigest(await allBrands()));
});
app.post('/api/angle', aiLimit, async (req, res) => {
  try {
    const { text, kind, image, video } = req.body || {};
    const r = await quickAngle(text, kind, image, video, optionalUid(req));
    res.json({ angle: r.angle, hook: r.hook, creative: r.creative, apply: r.apply, script: r.script });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// "Your brand" knowledge base — PER ACCOUNT: each customer scans their own brand once,
// used to tailor every competitor insight into a realistic "apply to your brand" tip.
app.get('/api/my-brand', async (req, res) => {
  try {
    const uid = optionalUid(req);
    res.json({ brand: uid ? await getMyBrand(uid) : null });   // anonymous visitors see no brand — never someone else's
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/my-brand', requireAuth, async (req, res) => {
  try {
    const { name, website, mainProduct } = req.body || {};
    const brand = await setMyBrand(req.user.uid, name, website, mainProduct);
    res.json({ brand });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.delete('/api/my-brand', requireAuth, async (req, res) => {
  try {
    await clearMyBrand(req.user.uid);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Register a user-added competitor for the daily warm + kick off its first capture now.
app.post('/api/track', async (req, res) => {
  try {
    const { name, host, url, country, key } = req.body || {};
    const admin = !!(process.env.ADMIN_KEY && key === process.env.ADMIN_KEY);   // owner bypass
    // Enrolment costs money (daily scraping) — only signed-in customers or the owner.
    if (!admin && !optionalUid(req)) return res.status(401).json({ error: 'Sign in required.' });
    const r = await addTracked({ name, host, url, country }, admin);
    res.json({ ok: true, added: !!(r && r.added), limited: !!(r && r.limited) });
    if (r && r.added) warmBrand(r.comp, false).catch(() => {});   // immediate baseline (async)
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Feature requests / feedback. Anyone can POST; only the owner (admin key) can list.
app.post('/api/feedback', async (req, res) => {
  try {
    res.json(await storeFeedback(req.body));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.get('/api/feedback', async (req, res) => {
  try {
    if (!process.env.ADMIN_KEY || req.query.key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Owner key required.' });
    res.json({ feedback: await listFeedback() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Image proxy — streams social CDN thumbnails so hotlink/expiry never breaks them
// in the browser. Locked to known social CDNs so it can't be abused as an open proxy.
const IMG_HOSTS = /(^|\.)(cdninstagram\.com|fbcdn\.net|tiktokcdn\.com|tiktokcdn-us\.com|ibyteimg\.com|akamaized\.net)$/i;
app.get('/api/img', async (req, res) => {
  try {
    const u = String(req.query.u || '');
    let host;
    try { host = new URL(u).hostname; } catch { return res.status(400).end(); }
    if (!/^https:$/.test(new URL(u).protocol) || !IMG_HOSTS.test(host)) return res.status(400).end();
    const r = await fetch(u, { headers: { 'User-Agent': UA_IMG, Accept: 'image/avif,image/webp,image/*,*/*' } });
    if (!r.ok) return res.status(502).end();
    res.set('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.status(500).end();
  }
});
const UA_IMG = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

// Website screenshot proxy. With SCREENSHOTONE_KEY set, uses ScreenshotOne with
// cookie/consent banners + ad/chat widgets auto-blocked. Falls back to WordPress
// mShots (no key, but bakes in any popup) so the screenshot always works.
app.get('/api/shot', aiLimit, async (req, res) => {
  try {
    const u = String(req.query.url || '');
    if (!/^https?:\/\//i.test(u)) return res.status(400).end();
    const key = process.env.SCREENSHOTONE_KEY;
    const target = key
      ? 'https://api.screenshotone.com/take?access_key=' + encodeURIComponent(key) +
        '&url=' + encodeURIComponent(u) +
        '&format=jpg&image_quality=82&viewport_width=1280&viewport_height=860' +
        '&block_cookie_banners=true&block_banners_by_heuristics=true&block_ads=true&block_chats=true' +
        '&cache=true&cache_ttl=86400'
      : 'https://s.wordpress.com/mshots/v1/' + encodeURIComponent(u) + '?w=1100';
    const r = await fetch(target, { headers: { 'User-Agent': UA_IMG } });
    if (!r.ok) return res.status(502).end();
    res.set('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.status(500).end();
  }
});

app.post('/api/signup', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const r = await signup(email, password);
    res.json(r);
    // Ping the founder so pending accounts get approved fast (manual billing model).
    if (r && r.pending) {
      postText('👤 *New WatchBack signup awaiting approval:* ' + r.email +
        '\nApprove: https://competitor-intelligence-production-2629.up.railway.app/api/admin/approve?email=' + encodeURIComponent(r.email) + '&key=YOUR_ADMIN_KEY' +
        '\nAll pending: …/api/admin/users?key=YOUR_ADMIN_KEY').catch(() => {});
    }
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ── Owner-only account approval (private beta, manual billing) ────────────────
app.get('/api/admin/users', async (req, res) => {
  if (!process.env.ADMIN_KEY || req.query.key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Owner key required.' });
  try {
    const r = await pool.query('SELECT id, email, approved, created_at FROM users ORDER BY id DESC LIMIT 200');
    res.json({ users: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/admin/approve', async (req, res) => {
  if (!process.env.ADMIN_KEY || req.query.key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Owner key required.' });
  try {
    const email = String(req.query.email || '').trim().toLowerCase();
    const approved = req.query.revoke === '1' ? false : true;
    const r = await pool.query('UPDATE users SET approved = $2 WHERE email = $1 RETURNING id, email, approved', [email, approved]);
    if (!r.rows[0]) return res.status(404).json({ error: 'No account with that email.' });
    res.json({ ok: true, user: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    res.json(await login(email, password));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: { id: req.user.uid, email: req.user.email } });
});

app.get('/api/competitors', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id, name, host, url, country, status, handles, created_at, updated_at FROM competitors WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.uid],
    );
    res.json({ competitors: r.rows });
  } catch (e) {
    res.status(500).json({ error: 'Could not load competitors.' });
  }
});

app.post('/api/competitors', requireAuth, async (req, res) => {
  try {
    const { name, host, url, country, handles, status } = req.body || {};
    if (!name || !host || !url) return res.status(400).json({ error: 'Missing name, host, or url.' });
    const h = String(host).replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '').toLowerCase().slice(0, 200);
    const r = await pool.query(
      `INSERT INTO competitors(user_id, name, host, url, country, handles, status)
       VALUES($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, host) DO UPDATE SET name = EXCLUDED.name, url = EXCLUDED.url, country = EXCLUDED.country, handles = EXCLUDED.handles, updated_at = now()
       RETURNING id, name, host, url, country, status, handles, created_at, updated_at`,
      [req.user.uid, String(name).slice(0, 120), h, String(url).slice(0, 500), String(country || 'ALL').slice(0, 8), JSON.stringify(handles || {}), String(status || 'setup').slice(0, 24)],
    );
    res.json({ competitor: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: 'Could not save competitor.' });
  }
});

// Update a competitor's watch status (setup -> baseline -> watching), per user.
app.patch('/api/competitors/:id', requireAuth, async (req, res) => {
  try {
    const { status } = req.body || {};
    const r = await pool.query(
      'UPDATE competitors SET status = $1, updated_at = now() WHERE id = $2 AND user_id = $3 RETURNING id, status, updated_at',
      [String(status || 'setup').slice(0, 24), req.params.id, req.user.uid],
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found.' });
    res.json({ competitor: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: 'Could not update status.' });
  }
});

app.delete('/api/competitors/:id', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM competitors WHERE id = $1 AND user_id = $2 RETURNING host', [req.params.id, req.user.uid]);
    res.json({ ok: true });
    // Stop the daily warm for this host once NO customer tracks it anymore ("one
    // competitor = one dataset" — keep scraping while any other account still has it).
    const host = r.rows[0] && r.rows[0].host;
    if (host) {
      try {
        const still = await pool.query('SELECT 1 FROM competitors WHERE host = $1 LIMIT 1', [host]);
        if (!still.rowCount) await removeTracked(host);
      } catch (e) { /* cleanup is best-effort */ }
    }
  } catch (e) {
    res.status(500).json({ error: 'Could not remove competitor.' });
  }
});

const PORT = process.env.PORT || 3000;
function start() {
  if (JWT_IS_DEFAULT) console.warn('⚠  JWT_SECRET is not set — sessions are signed with a PUBLIC default key. Set JWT_SECRET in Railway before real users sign in.');
  app.listen(PORT, () => { console.log('✓ API listening on :' + PORT); startScheduler(); });
}
// Start the server no matter what — if the DB isn't wired yet, accounts are
// disabled but the ads endpoint still works.
initSchema().then(start).catch((err) => {
  console.warn('DB not ready — accounts disabled, ads still work:', err.message);
  start();
});
