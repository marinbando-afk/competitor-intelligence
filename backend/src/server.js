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
import { signup, login, createUser, setPassword, changePassword, requireAuth, optionalUid, JWT_IS_DEFAULT } from './auth.js';
import { randomBytes } from 'crypto';
import { fetchAds, adsChanges } from './ads.js';
import { fetchSocial, resolveHandles } from './social.js';
import { startScheduler, warmStatus, addTracked, removeTracked, getTracked, warmBrand, allBrands, warmUsage, TRACKED } from './refresh.js';
import { postText, postDailyBrief, buildDailyBrief, isSlackWebhook, postTo } from './slack.js';
import { storeInbound, getEmails, recentEmails, getEmailHtml } from './email.js';
import { chat } from './chat.js';
import { websiteCompare } from './website.js';
import { getInsights, generateInsights, quickAngle, creditStatus, enrichCreativeHooks, backfillWebsiteReads } from './insights.js';
import { getMyBrand, setMyBrand, clearMyBrand } from './brand.js';
import { storeFeedback, listFeedback } from './feedback.js';
import { systemStats } from './stats.js';
import { getWeekly, generateWeekly, mondayOf } from './weekly.js';
import { snapshotDays, snapshotForDay, recentSnapshots, saveSnapshot, latestSnapshot } from './snapshots.js';

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

// Admin = the legacy ADMIN_KEY (query/body) OR a signed-in account with the admin
// flag (the founder). DB-checked per call so it works with older tokens and revokes
// take effect immediately.
async function isAdminReq(req) {
  // A SIGNED-IN session is judged ONLY by its own account flag. The legacy ?admin=<key>
  // used to be checked first, which meant any account signed in on a browser that had ever
  // visited ?admin=<key> (the key is cached in localStorage forever) held REAL admin —
  // a client session could list/create/delete clients. The account decides; the key cannot
  // elevate someone else.
  const uid = optionalUid(req);
  if (uid) {
    try { const r = await pool.query('SELECT admin FROM users WHERE id = $1', [uid]); return !!(r.rows[0] && r.rows[0].admin); }
    catch (e) { return false; }
  }
  // Anonymous only: the founder's legacy owner key.
  if (process.env.ADMIN_KEY && (req.query.key === process.env.ADMIN_KEY || (req.body && req.body.key) === process.env.ADMIN_KEY)) return true;
  return false;
}

// The uid to PERSONALIZE an open read endpoint for: a signed-in user's own uid, OR —
// when a public read-only SHARE token is supplied (?share=… / body.share) — the CLIENT
// that owns that token, so a shared dashboard is tailored to that client's brand for
// their team. Read-only by construction: this only ever selects whose *brand context*
// to read with; it never grants write access (all mutations are behind requireAuth).
async function viewUid(req) {
  // A share token WINS over any signed-in session: opening a share link is an explicit
  // request to view THAT client's dashboard, so it must read with the client's brand
  // context — otherwise the founder (or any logged-in viewer) previewing a client's link
  // would see their OWN brand's tailoring instead of the client's.
  const token = String((req.query && req.query.share) || (req.body && req.body.share) || '').trim();
  if (token) {
    try { const r = await pool.query('SELECT id FROM users WHERE share_token = $1', [token]); if (r.rows[0]) return r.rows[0].id; }
    catch (e) { /* fall through to the signed-in user */ }
  }
  return optionalUid(req);
}

function newShareToken() { return randomBytes(9).toString('base64url'); }   // ~12 url-safe chars

// How many competitors an account may add. Per-account override lives in
// users.max_competitors (set by the founder in the admin Clients panel); NULL falls back
// to the default plan limit. The founder's own admin account is unlimited.
// Do we already hold captures for this host (i.e. someone else already watches it)?
// Competitor data is shared per-host, so such a brand needs NO baseline — it's ready the
// instant it's added.
async function hasHistory(host) {
  try { const r = await pool.query('SELECT 1 FROM snapshots WHERE host = $1 LIMIT 1', [host]); return !!r.rowCount; }
  catch (e) { return false; }
}

// Repair rows stuck on 'setup' for a host we ALREADY had captures for before the row was
// added — those never needed a baseline. warmBrand only flips the status when it actually
// runs, and it doesn't run for an already-tracked host, so such a row would otherwise show
// "capturing a live baseline…" until the next nightly warm despite its data being right
// there. Rows for genuinely new brands (no snapshots predating them) are left to baseline.
// Pass a uid to scope to one account; omit to heal every account.
async function healStaleSetup(uid) {
  try {
    // updated_at drives the app's "scanned X ago", so it must be the real CAPTURE time —
    // stamping now() here would claim we'd just scanned the brand when we only repaired a
    // flag. Use the host's newest snapshot instead.
    await pool.query(
      `UPDATE competitors SET status = 'watching',
              updated_at = COALESCE((SELECT MAX(s.created_at) FROM snapshots s WHERE s.host = competitors.host), updated_at)
        WHERE ${uid ? 'user_id = $1 AND ' : ''}status = 'setup'
          AND EXISTS (SELECT 1 FROM snapshots s WHERE s.host = competitors.host AND s.created_at < competitors.created_at)`,
      uid ? [uid] : []);
    // A row can never have been "scanned" more recently than its newest capture. Pull any
    // such claim back to the real thing (only ever lowers it, so it's idempotent) — this
    // also repairs rows an earlier heal stamped with now().
    await pool.query(
      `UPDATE competitors SET updated_at = sub.mx
         FROM (SELECT host, MAX(created_at) AS mx FROM snapshots GROUP BY host) sub
        WHERE competitors.host = sub.host AND competitors.updated_at > sub.mx
              ${uid ? 'AND competitors.user_id = $1' : ''}`,
      uid ? [uid] : []);
  } catch (e) { /* best-effort */ }
}

const DEFAULT_MAX_COMPETITORS = Number(process.env.DEFAULT_MAX_COMPETITORS) || 2;
// Mirror a client's competitor onto every ADMIN account, so the founder sees everything
// his clients track on his own dashboard instead of only as a list in the Clients panel.
// Free: a competitor is one shared dataset keyed by host (all snapshots are per-host), so
// this adds a watchlist POINTER, never a second scrape.
//
// DO NOTHING, not DO UPDATE: if the admin has renamed or re-countried his own copy, a
// client re-saving theirs must not silently overwrite it. Admins are Infinity-capped
// (competitorAllowance), so a mirror can never push them over a limit.
async function mirrorToAdmins(byUid, c) {
  try {
    const admins = await pool.query('SELECT id FROM users WHERE admin = TRUE');
    for (const a of admins.rows) {
      if (a.id === byUid) continue;   // the adder IS an admin — already on their dashboard
      await pool.query(
        `INSERT INTO competitors(user_id, name, host, url, country, handles, status)
         VALUES($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (user_id, host) DO NOTHING`,
        [a.id, c.name, c.host, c.url, c.country || 'ALL', JSON.stringify(c.handles || {}), c.status || 'setup'],
      );
    }
  } catch (e) { console.warn('mirrorToAdmins ' + (c && c.host) + ':', e.message); }
}

async function competitorAllowance(uid) {
  try {
    const r = await pool.query('SELECT admin, max_competitors FROM users WHERE id = $1', [uid]);
    if (!r.rows[0]) return DEFAULT_MAX_COMPETITORS;
    if (r.rows[0].admin) return Infinity;
    return r.rows[0].max_competitors == null ? DEFAULT_MAX_COMPETITORS : r.rows[0].max_competitors;
  } catch (e) { return DEFAULT_MAX_COMPETITORS; }
}

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
    const qh = String(req.query.host || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '').toLowerCase();
    const force = req.query.force === '1';
    const pageId = String(req.query.pageId || '').replace(/\D/g, '');   // page-scoped probe (temporary, not persisted)
    let data = null;
    // FAST PATH: serve the PERSISTED daily capture (Postgres, survives restarts) so a
    // pre-warmed competitor's ads appear instantly — instead of waiting on a live scrape
    // whenever the in-memory cache is cold (every deploy resets it). It's the same capture
    // the AI-read uses, so the panel and the read stay consistent. force=1 always re-scrapes.
    if (qh && !force && !pageId) {
      try { const snap = await latestSnapshot(qh, 'ads'); if (snap && Array.isArray(snap.ads) && snap.ads.length) data = snap; } catch (e) { /* fall through to live */ }
    }
    if (!data) {
      // One competitor = one dataset. If this host is already tracked (by any customer or
      // as a demo), scrape under its CANONICAL name + country so slightly different names
      // for the same competitor share one cache entry (the one the nightly warm keeps hot).
      let brand = req.query.brand, country = req.query.country;
      if (qh) {
        try { const t = (await allBrands()).find((b) => b.host === qh); if (t) { brand = t.name; country = t.country; } }
        catch (e) { /* canonicalization is best-effort */ }
      }
      data = await fetchAds(brand, country, force || !!pageId, false, qh, pageId);
      // On an explicit force-refresh of a tracked competitor, persist the fresh capture so the
      // AI-read/insights (which read the saved 'ads' snapshot) reflect the same attribution.
      // Carry forward the pre-computed creative analysis (budget 0 = reuse only, no new vision
      // cost) so a force-refresh doesn't strip the preloaded hooks the ad modal shows instantly.
      if (qh && force && !pageId && data.ads && data.ads.length) {
        try { await enrichCreativeHooks(qh, 'ads', 'ad', data.ads, { left: 0 }); await saveSnapshot(qh, 'ads', data); } catch (e) { /* best-effort */ }
      }
    }
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
// Social posts are served STALE-WHILE-REVALIDATE. A live Apify scrape takes 35–63s per
// platform, and a customer's OWN competitors aren't in the daily 5am warm (only demos are),
// so every view used to trigger that full scrape — the in-memory cache in social.js dies on
// each restart, so it never helped across deploys. Now: if we hold a persisted snapshot we
// return it INSTANTLY and refresh in the background; only a competitor we've genuinely never
// scraped pays the one-time wait. (found 17 Jul — Seranova FB 63s, IG 35s, every view.)
const SOCIAL_FRESH_MS = 12 * 60 * 60 * 1000;   // don't bother re-scraping a snapshot younger than this
const _socRefreshing = new Set();               // hosts+platforms with a background refresh already in flight

function normSocHost(h) { return String(h || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '').toLowerCase(); }

// Re-scrape and persist in the background — fire-and-forget, never blocks the response.
function refreshSocialBg(platform, handle, host) {
  const k = platform + '|' + host;
  if (_socRefreshing.has(k)) return;            // don't stack refreshes for the same profile
  _socRefreshing.add(k);
  Promise.resolve()
    .then(() => fetchSocial(platform, handle, host, true))   // force = bypass the in-memory TTL
    .then((fresh) => { if (fresh && fresh.posts && fresh.posts.length) return saveSnapshot(host, platform, { ...fresh, _at: Date.now() }); })
    .catch((e) => console.warn('social bg refresh ' + k + ': ' + e.message))
    .finally(() => _socRefreshing.delete(k));
}

app.get('/api/social', async (req, res) => {
  try {
    const platform = req.query.platform;
    const host = normSocHost(req.query.host);

    // 1) Serve a persisted snapshot immediately when we have one — the whole point is that
    // nobody waits 60s for a scrape we could already show.
    if (host && platform) {
      try {
        const rows = await recentSnapshots(host, platform, 1);
        const snap = rows[0] && rows[0].data;
        if (snap && snap.posts && snap.posts.length) {
          const ageMs = snap._at ? (Date.now() - snap._at) : (Date.now() - Date.parse(rows[0].day + 'T00:00:00Z'));
          if (ageMs >= SOCIAL_FRESH_MS) refreshSocialBg(platform, req.query.handle || snap.handle, host);   // stale → refresh behind the scenes
          return res.json({ handle: snap.handle || req.query.handle || '', posts: snap.posts, summary: snap.summary, cached: true });
        }
      } catch (e) { /* fall through to a live scrape */ }
    }

    // 2) No snapshot yet (a brand-new competitor) — pay the one-time live scrape, then persist
    // it so every later view is instant.
    const live = await fetchSocial(platform, req.query.handle, req.query.host);
    if (host && platform && live && live.posts && live.posts.length) {
      try { await saveSnapshot(host, platform, { ...live, _at: Date.now() }); } catch (e) { /* best-effort */ }
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
    // Already tracked? Reuse its CONFIRMED handles instead of re-resolving from scratch —
    // so re-adding a known brand keeps its correct pages (and never blanks them).
    try { const known = (await allBrands()).find((b) => b.host === host); if (known && known.handles && Object.keys(known.handles).length) return res.json({ host, handles: known.handles, known: true }); } catch (e) { /* fall back to a fresh resolve */ }
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
    // The brand NAME is what makes sending-domain aliasing work ("Glov Beauty" → tryglov.com);
    // the domain label alone ("glovbeauty") matches nothing. The frontend doesn't send a name,
    // so resolve it from the tracked list — same pattern as /api/ads above.
    const host = String(req.query.host || '').toLowerCase();
    let name = req.query.name || '';
    if (!name && host) { try { const t = (await allBrands()).find((b) => b.host === host); if (t) name = t.name; } catch (e) { /* fall back to the domain label */ } }
    res.json(await getEmails(req.query.host, name));
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
    // Each question is a real AI spend — account holders, or a team member viewing a
    // read-only share link (tailored to the client that owns the link).
    const uid = await viewUid(req);
    if (!uid) return res.status(401).json({ error: 'Sign in to use the AI analyst.' });
    res.json(await chat(req.body, uid));
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
    const force = req.query.force === '1' && (await isAdminReq(req));   // re-capture now (admin only — each one costs a real screenshot)
    res.json(await websiteCompare(req.query.host, req.query.url, req.query.day, force));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// AI insights — per-channel, context-aware read (cached daily, generated on demand).
app.get('/api/insights', async (req, res) => {
  try {
    res.json({ insights: await getInsights(req.query.host, req.query.name, req.query.refresh === '1', await viewUid(req)) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// One-line marketing angle (+ how YOUR brand could apply it) for a single ad/post.
// Quick Anthropic balance probe (cached ~5 min) — so I can check if AI credits ran dry.
app.get('/api/credits', async (req, res) => { res.json(await creditStatus(req.query.fresh === '1')); });
// Send the Slack daily brief now (on-demand / for testing). Posts only to your SLACK_WEBHOOK_URL.
app.get('/api/slack-test', async (req, res) => {
  if (!(await isAdminReq(req))) return res.status(403).json({ error: 'Admin only.' });
  const clientBrands = (await allBrands()).filter((b) => !TRACKED.some((t) => t.host === b.host));
  res.json(await postDailyBrief(clientBrands.length ? clientBrands : await allBrands()));
});

// Preview today's daily brief without posting (same text the Slack message carries).
let _briefCache = { at: 0, val: null };
app.get('/api/daily-brief', aiLimit, async (req, res) => {
  try {
    if (_briefCache.val && Date.now() - _briefCache.at < 30 * 60 * 1000 && req.query.fresh !== '1') return res.json({ text: _briefCache.val, cached: true });
    const clientBrands = (await allBrands()).filter((b) => !TRACKED.some((t) => t.host === b.host));
    const text = await buildDailyBrief(clientBrands);
    _briefCache = { at: Date.now(), val: text };
    res.json({ text });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/angle', aiLimit, async (req, res) => {
  try {
    const { text, kind, image, video } = req.body || {};
    const r = await quickAngle(text, kind, image, video, await viewUid(req));
    res.json({ angle: r.angle, hook: r.hook, creative: r.creative, apply: r.apply, script: r.script });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// "Your brand" knowledge base — PER ACCOUNT: each customer scans their own brand once,
// used to tailor every competitor insight into a realistic "apply to your brand" tip.
app.get('/api/my-brand', async (req, res) => {
  try {
    const uid = await viewUid(req);   // signed-in user, or the client behind a read-only share link
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
    const admin = await isAdminReq(req);   // owner bypass (key or admin login)
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
    if (!(await isAdminReq(req))) return res.status(403).json({ error: 'Admin only.' });
    res.json({ feedback: await listFeedback() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Image proxy — streams social CDN thumbnails so hotlink/expiry never breaks them
// in the browser. Locked to known social CDNs so it can't be abused as an open proxy.
const IMG_HOSTS = /(^|\.)(cdninstagram\.com|fbcdn\.net|tiktokcdn\.com|tiktokcdn-us\.com|ibyteimg\.com|akamaized\.net)$/i;
app.get('/api/img', async (req, res) => {
  try {
    const u = String(req.query.u || '');
    let parsed;
    try { parsed = new URL(u); } catch { return res.status(400).end(); }
    if (!/^https:$/.test(parsed.protocol) || !IMG_HOSTS.test(parsed.hostname)) return res.status(400).end();
    // Facebook serves reel/post covers from GEO-PINNED regional edges (scontent.f<region>N.
    // fna.fbcdn.net) that don't resolve from our datacenter — the fetch throws, the card
    // shows a broken image (Seranova's reels, 17 Jul). The fbcdn signature (oh/oe params)
    // is host-independent, so rewrite the regional host to the GLOBAL edge, which is
    // reachable everywhere. Verified: .fna host -> HTTP 000, rewritten -> a real JPEG.
    let target = u;
    if (/\.fna\.fbcdn\.net$/i.test(parsed.hostname)) { parsed.hostname = 'scontent.xx.fbcdn.net'; target = parsed.toString(); }
    let r = await fetch(target, { headers: { 'User-Agent': UA_IMG, Accept: 'image/avif,image/webp,image/*,*/*' } });
    // Belt and braces: if the rewrite somehow 4xx/5xx, fall back to the original URL.
    if (!r.ok && target !== u) r = await fetch(u, { headers: { 'User-Agent': UA_IMG, Accept: 'image/avif,image/webp,image/*,*/*' } });
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
  if (!(await isAdminReq(req))) return res.status(403).json({ error: 'Admin only.' });
  try {
    const r = await pool.query('SELECT id, email, approved, admin, created_at FROM users ORDER BY id DESC LIMIT 200');
    res.json({ users: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/admin/approve', async (req, res) => {
  if (!(await isAdminReq(req))) return res.status(403).json({ error: 'Admin only.' });
  try {
    const email = String(req.query.email || '').trim().toLowerCase();
    const approved = req.query.revoke === '1' ? false : true;
    const r = await pool.query('UPDATE users SET approved = $2 WHERE email = $1 RETURNING id, email, approved', [email, approved]);
    if (!r.rows[0]) return res.status(404).json({ error: 'No account with that email.' });
    res.json({ ok: true, user: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Reject/delete a signup entirely (their competitors cascade-delete). Admins can't
// delete another admin or themselves, as a guardrail.
app.get('/api/admin/delete-user', async (req, res) => {
  if (!(await isAdminReq(req))) return res.status(403).json({ error: 'Admin only.' });
  try {
    const email = String(req.query.email || '').trim().toLowerCase();
    const r = await pool.query('DELETE FROM users WHERE email = $1 AND admin = FALSE RETURNING id', [email]);
    if (!r.rows[0]) return res.status(404).json({ error: 'No non-admin account with that email.' });
    res.json({ ok: true, deleted: email });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Force-regenerate the tenant-neutral insights + current-week weekly for every brand now
// (e.g. after a change to how the shared reads are generated). Runs in the background so
// the request returns immediately; overlays are per-viewer and regenerate lazily on read.
let _adminRefreshing = false;
app.post('/api/admin/refresh', async (req, res) => {
  if (!(await isAdminReq(req))) return res.status(403).json({ error: 'Admin only.' });
  if (_adminRefreshing) return res.json({ ok: true, already: true });
  _adminRefreshing = true;
  res.json({ ok: true, started: true });
  (async () => {
    let n = 0;
    try {
      const brands = await allBrands();
      const curMon = mondayOf(new Date().toISOString().slice(0, 10));
      for (const b of brands) {
        try { await generateInsights(b.name, b.host); } catch (e) { /* best-effort */ }
        try { await generateWeekly(b.host, b.name, curMon); } catch (e) { /* best-effort */ }
        n++;
      }
      console.log('✓ admin refresh: regenerated insights+weekly for ' + n + ' brand(s)');
    } catch (e) { console.warn('admin refresh:', e.message); }
    finally { _adminRefreshing = false; }
  })();
});

// One-time, HOST-SCOPED historical fix: re-read each stored day's banner from that day's
// screenshot and regenerate that day's website read, so a past sale switch lands on the
// day it visibly changed. Only the named host is touched.
app.post('/api/admin/backfill-banners', async (req, res) => {
  if (!(await isAdminReq(req))) return res.status(403).json({ error: 'Admin only.' });
  const host = String((req.body && req.body.host) || req.query.host || '').toLowerCase().trim();
  if (!host || host.indexOf('.') < 0) return res.status(400).json({ error: 'host required' });
  res.json({ ok: true, started: true, host });
  (async () => {
    try {
      const t = (await allBrands()).find((b) => b.host === host);
      const r = await backfillWebsiteReads(host, t ? t.name : host);
      console.log('✓ backfill-banners ' + host + ': ' + JSON.stringify(r));
    } catch (e) { console.warn('backfill-banners ' + host + ':', e.message); }
  })();
});

// ── Admin: client accounts + their competitors (the founder's "Clients" panel) ──
// Each client is a non-admin user with their own competitor set and a public
// read-only share token. All routes are admin-gated.

// List every client account with its competitors + share token.
app.get('/api/admin/clients', async (req, res) => {
  if (!(await isAdminReq(req))) return res.status(403).json({ error: 'Admin only.' });
  try {
    await healStaleSetup();   // tidy every client's stale 'setup' row while we're here
    const us = await pool.query('SELECT id, email, approved, share_token, max_competitors, created_at FROM users WHERE admin = FALSE ORDER BY created_at DESC');
    const cs = await pool.query('SELECT id, user_id, name, host, url, country, status, handles FROM competitors ORDER BY created_at ASC');
    const byUser = {};
    for (const c of cs.rows) (byUser[c.user_id] = byUser[c.user_id] || []).push(c);
    res.json({ dflt: DEFAULT_MAX_COMPETITORS, warm: await warmUsage(), clients: us.rows.map((u) => ({ id: u.id, email: u.email, approved: u.approved, share_token: u.share_token, max_competitors: u.max_competitors, created_at: u.created_at, competitors: byUser[u.id] || [] })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Create a client login (pre-approved) and mint its share token.
app.post('/api/admin/clients', async (req, res) => {
  if (!(await isAdminReq(req))) return res.status(403).json({ error: 'Admin only.' });
  try {
    const { email, password } = req.body || {};
    const u = await createUser(email, password, { approved: true });
    const token = newShareToken();
    await pool.query('UPDATE users SET share_token = $2 WHERE id = $1', [u.id, token]);
    res.json({ client: { id: u.id, email: u.email, share_token: token, competitors: [] } });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Raise / lower a client's competitor allowance (blank or null = back to the default).
app.post('/api/admin/clients/:id/limit', async (req, res) => {
  if (!(await isAdminReq(req))) return res.status(403).json({ error: 'Admin only.' });
  try {
    const raw = (req.body || {}).max;
    const n = (raw === null || raw === undefined || raw === '') ? null : Math.max(0, Math.min(500, parseInt(raw, 10) || 0));
    const r = await pool.query('UPDATE users SET max_competitors = $2 WHERE id = $1 AND admin = FALSE RETURNING id, max_competitors', [Number(req.params.id), n]);
    if (!r.rows[0]) return res.status(404).json({ error: 'No such client.' });
    res.json({ ok: true, max_competitors: r.rows[0].max_competitors, dflt: DEFAULT_MAX_COMPETITORS });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Reset a client's password.
app.post('/api/admin/clients/:id/password', async (req, res) => {
  if (!(await isAdminReq(req))) return res.status(403).json({ error: 'Admin only.' });
  try { await setPassword(Number(req.params.id), (req.body || {}).password); res.json({ ok: true }); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Mint / rotate a client's share token (old links stop working).
app.post('/api/admin/clients/:id/share', async (req, res) => {
  if (!(await isAdminReq(req))) return res.status(403).json({ error: 'Admin only.' });
  try {
    const token = newShareToken();
    const r = await pool.query('UPDATE users SET share_token = $2 WHERE id = $1 AND admin = FALSE RETURNING id', [Number(req.params.id), token]);
    if (!r.rows[0]) return res.status(404).json({ error: 'No such client.' });
    res.json({ share_token: token });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete a client account (competitors cascade; prune the warm list for now-orphaned hosts).
app.delete('/api/admin/clients/:id', async (req, res) => {
  if (!(await isAdminReq(req))) return res.status(403).json({ error: 'Admin only.' });
  try {
    const id = Number(req.params.id);
    const hosts = await pool.query('SELECT host FROM competitors WHERE user_id = $1', [id]);
    const del = await pool.query('DELETE FROM users WHERE id = $1 AND admin = FALSE RETURNING id', [id]);
    if (!del.rows[0]) return res.status(404).json({ error: 'No such client.' });
    res.json({ ok: true });
    for (const row of hosts.rows) {
      try { const s = await pool.query('SELECT 1 FROM competitors WHERE host = $1 LIMIT 1', [row.host]); if (!s.rowCount) await removeTracked(row.host); }
      catch (e) { /* best-effort */ }
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Add a competitor to a client (mirrors POST /api/competitors + warm enrolment +
// best-effort social-handle resolution, then kicks off an immediate baseline capture).
app.post('/api/admin/clients/:id/competitors', async (req, res) => {
  if (!(await isAdminReq(req))) return res.status(403).json({ error: 'Admin only.' });
  try {
    const id = Number(req.params.id);
    const owner = await pool.query('SELECT 1 FROM users WHERE id = $1 AND admin = FALSE', [id]);
    if (!owner.rowCount) return res.status(404).json({ error: 'No such client.' });
    let { name, host, url, country, handles } = req.body || {};
    host = String(host || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '').toLowerCase().slice(0, 200);
    if (!host || host.indexOf('.') < 0) return res.status(400).json({ error: 'A valid competitor domain is required.' });
    name = String(name || host).slice(0, 120);
    url = String(url || ('https://' + host)).slice(0, 500);
    country = String(country || 'ALL').slice(0, 8).toUpperCase();
    if (!handles || !Object.keys(handles).length) { try { handles = await resolveHandles(host); } catch (e) { handles = {}; } }
    const st = (await hasHistory(host)) ? 'watching' : 'setup';   // already captured → no baseline needed
    const r = await pool.query(
      `INSERT INTO competitors(user_id, name, host, url, country, handles, status)
       VALUES($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, host) DO UPDATE SET name = EXCLUDED.name, url = EXCLUDED.url, country = EXCLUDED.country, handles = EXCLUDED.handles, updated_at = now()
       RETURNING id, name, host, url, country, status, handles`,
      [id, name, host, url, country, JSON.stringify(handles || {}), st]);
    res.json({ competitor: r.rows[0] });
    // Enrol in the daily warm and capture a first baseline now (both async, best-effort).
    try { const t = await addTracked({ name, host, url, country, handles }, true); if (t && t.added) warmBrand(t.comp, false).catch(() => {}); }
    catch (e) { /* warm enrol best-effort */ }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Remove a competitor from a client (prune the warm list if it was the last watcher).
app.delete('/api/admin/clients/:id/competitors/:cid', async (req, res) => {
  if (!(await isAdminReq(req))) return res.status(403).json({ error: 'Admin only.' });
  try {
    const r = await pool.query('DELETE FROM competitors WHERE id = $1 AND user_id = $2 RETURNING host', [Number(req.params.cid), Number(req.params.id)]);
    res.json({ ok: true });
    const host = r.rows[0] && r.rows[0].host;
    if (host) { const s = await pool.query('SELECT 1 FROM competitors WHERE host = $1 LIMIT 1', [host]); if (!s.rowCount) await removeTracked(host); }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Public read-only share: open a client's dashboard by share token ──────────
// Returns ONLY the client's competitor list + brand name for rendering; no email,
// no credentials. Read-only — the frontend hides every editing control, and all
// mutating endpoints stay behind requireAuth regardless.
app.get('/api/shared/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    if (!token) return res.status(404).json({ error: 'Not found.' });
    const u = await pool.query('SELECT id FROM users WHERE share_token = $1', [token]);
    if (!u.rows[0]) return res.status(404).json({ error: 'This shared link is no longer active.' });
    const uid = u.rows[0].id;
    const cs = await pool.query('SELECT id, name, host, url, country, status, handles, created_at, updated_at FROM competitors WHERE user_id = $1 ORDER BY created_at ASC', [uid]);
    let brand = null;
    try { const b = await getMyBrand(uid); if (b && b.name) brand = { name: b.name }; } catch (e) { /* optional */ }
    res.json({ readonly: true, brand, competitors: cs.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Change your OWN password (any account, including the founder's). Requires the current
// password — see auth.changePassword.
app.post('/api/password', requireAuth, async (req, res) => {
  try {
    const { current, next } = req.body || {};
    await changePassword(req.user.uid, current, next);
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ── Self-serve read-only share link for the signed-in account ─────────────────
// Any user can mint / copy a link that lets teammates VIEW their dashboard and chat
// with the AI, read-only (same mechanism the admin panel exposes for client accounts).
app.get('/api/share', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT share_token FROM users WHERE id = $1', [req.user.uid]);
    let token = r.rows[0] && r.rows[0].share_token;
    if (!token) { token = newShareToken(); await pool.query('UPDATE users SET share_token = $2 WHERE id = $1', [req.user.uid, token]); }
    res.json({ token });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/share/rotate', requireAuth, async (req, res) => {
  try { const token = newShareToken(); await pool.query('UPDATE users SET share_token = $2 WHERE id = $1', [req.user.uid, token]); res.json({ token }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    res.json(await login(email, password));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get('/api/me', requireAuth, async (req, res) => {
  let admin = false, slack = false, maxCompetitors = DEFAULT_MAX_COMPETITORS;
  try {
    const r = await pool.query('SELECT admin, slack_webhook, max_competitors FROM users WHERE id = $1', [req.user.uid]);
    admin = !!(r.rows[0] && r.rows[0].admin); slack = !!(r.rows[0] && r.rows[0].slack_webhook);
    if (r.rows[0] && r.rows[0].max_competitors != null) maxCompetitors = r.rows[0].max_competitors;
  } catch (e) { /* defaults */ }
  res.json({ user: { id: req.user.uid, email: req.user.email, admin, slack, maxCompetitors } });
});

// ── Per-account Slack connection ──────────────────────────────────────────────
app.get('/api/slack', requireAuth, async (req, res) => {
  try { const r = await pool.query('SELECT slack_webhook FROM users WHERE id=$1', [req.user.uid]); res.json({ connected: !!(r.rows[0] && r.rows[0].slack_webhook) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/slack', requireAuth, async (req, res) => {
  try {
    const url = String((req.body && req.body.webhook) || '').trim();
    if (!isSlackWebhook(url)) return res.status(400).json({ error: 'That doesn’t look like a Slack Incoming Webhook (it should start with https://hooks.slack.com/services/).' });
    const ping = await postTo(url, '✅ *WatchBack connected.* Your daily competitor brief will land here every morning — plus weekly report links on Mondays.');
    if (!ping.sent) return res.status(400).json({ error: 'Slack rejected that webhook — double-check you copied the full URL.' });
    await pool.query('UPDATE users SET slack_webhook=$2 WHERE id=$1', [req.user.uid, url]);
    res.json({ ok: true, connected: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/slack/test', aiLimit, requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT slack_webhook FROM users WHERE id=$1', [req.user.uid]);
    const w = r.rows[0] && r.rows[0].slack_webhook;
    if (!w) return res.status(400).json({ error: 'No Slack connected yet.' });
    const cs = await pool.query('SELECT name, host FROM competitors WHERE user_id=$1 ORDER BY created_at ASC', [req.user.uid]);
    const s = await postTo(w, await buildDailyBrief(cs.rows));
    res.json({ sent: s.sent });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/slack', requireAuth, async (req, res) => {
  try { await pool.query('UPDATE users SET slack_webhook=NULL WHERE id=$1', [req.user.uid]); res.json({ ok: true, connected: false }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// Preview the EXACT daily brief that would post to Slack — built from THIS account's own
// competitors, optionally plus the demo brands (?demos=1) — so the user can see what gets
// sent even before connecting Slack.
app.get('/api/slack/preview', aiLimit, requireAuth, async (req, res) => {
  try {
    const cs = await pool.query('SELECT name, host FROM competitors WHERE user_id=$1 ORDER BY created_at ASC', [req.user.uid]);
    const mine = cs.rows.map((c) => ({ name: c.name, host: c.host }));
    const seen = new Set(mine.map((c) => c.host));
    const demos = req.query.demos === '1' ? TRACKED.filter((t) => !seen.has(t.host)).map((t) => ({ name: t.name, host: t.host })) : [];
    const brands = mine.concat(demos);
    const text = await buildDailyBrief(brands);
    res.json({ text, count: brands.length, mine: mine.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/competitors', requireAuth, async (req, res) => {
  try {
    await healStaleSetup(req.user.uid);   // see helper: never sit on a baseline we don't need
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
    // Per-account competitor limit, enforced server-side (the UI gate alone is bypassable).
    // Editing/re-saving a competitor they already track never counts against it.
    const max = await competitorAllowance(req.user.uid);
    if (max !== Infinity) {
      const cnt = await pool.query('SELECT COUNT(*)::int AS n FROM competitors WHERE user_id = $1 AND host <> $2', [req.user.uid, h]);
      if (cnt.rows[0].n >= max) return res.status(403).json({ error: 'You’re at your plan limit of ' + max + ' competitor' + (max === 1 ? '' : 's') + '. Ask us to raise it.', limited: true, max });
    }
    // A brand we already capture needs no baseline — start it 'watching' so it doesn't sit
    // on "capturing a live baseline…" until the next nightly warm. Only a genuinely new
    // brand starts 'setup'; warmBrand flips that once its first capture lands.
    let st = String(status || 'setup').slice(0, 24);
    if (st === 'setup' && await hasHistory(h)) st = 'watching';
    const r = await pool.query(
      `INSERT INTO competitors(user_id, name, host, url, country, handles, status)
       VALUES($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, host) DO UPDATE SET name = EXCLUDED.name, url = EXCLUDED.url, country = EXCLUDED.country, handles = EXCLUDED.handles, updated_at = now()
       RETURNING id, name, host, url, country, status, handles, created_at, updated_at`,
      [req.user.uid, String(name).slice(0, 120), h, String(url).slice(0, 500), String(country || 'ALL').slice(0, 8), JSON.stringify(handles || {}), st],
    );
    // Best-effort and AFTER the client's own row is saved — the founder seeing his mirror
    // must never be able to fail the client's actual add.
    await mirrorToAdmins(req.user.uid, r.rows[0]);
    res.json({ competitor: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: 'Could not save competitor.' });
  }
});

// Update a competitor's watch status (setup -> baseline -> watching), per user.
app.patch('/api/competitors/:id', requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    // Status-only update (the lifecycle path) keeps its narrow query.
    if (b.status !== undefined && b.name === undefined && b.handles === undefined && b.url === undefined && b.country === undefined) {
      const r = await pool.query(
        'UPDATE competitors SET status = $1, updated_at = now() WHERE id = $2 AND user_id = $3 RETURNING id, status, updated_at',
        [String(b.status || 'setup').slice(0, 24), req.params.id, req.user.uid]);
      if (!r.rows[0]) return res.status(404).json({ error: 'Not found.' });
      return res.json({ competitor: r.rows[0] });
    }
    // Full edit: name / url / country / handles. Host (identity) is NOT changed here —
    // a different domain is a different competitor (the app deletes + re-adds for that).
    const r = await pool.query(
      `UPDATE competitors SET
         name = COALESCE($1, name), url = COALESCE($2, url), country = COALESCE($3, country),
         handles = COALESCE($4, handles), updated_at = now()
       WHERE id = $5 AND user_id = $6
       RETURNING id, name, host, url, country, status, handles, created_at, updated_at`,
      [b.name != null ? String(b.name).slice(0, 120) : null,
       b.url != null ? String(b.url).slice(0, 500) : null,
       b.country != null ? String(b.country).slice(0, 8).toUpperCase() : null,
       b.handles != null ? JSON.stringify(b.handles) : null,
       req.params.id, req.user.uid]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found.' });
    res.json({ competitor: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: 'Could not update competitor.' });
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
