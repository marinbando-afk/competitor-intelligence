// Competitor Intelligence AI — accounts API.
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
import { signup, login, requireAuth } from './auth.js';
import { fetchAds, adsChanges } from './ads.js';
import { fetchSocial } from './social.js';
import { startScheduler, warmStatus, TRACKED, addTracked, warmBrand } from './refresh.js';
import { storeInbound, getEmails, recentEmails, getEmailHtml } from './email.js';
import { chat } from './chat.js';
import { websiteCompare } from './website.js';
import { getInsights, quickAngle, generateInsights, creditStatus } from './insights.js';
import { getMyBrand, setMyBrand, clearMyBrand } from './brand.js';
import { storeFeedback, listFeedback } from './feedback.js';
import { snapshotDays, snapshotForDay } from './snapshots.js';

const app = express();
// Emails can be large; also accept form-encoded posts from inbound-email services.
app.use(express.json({ limit: '3mb' }));
app.use(express.urlencoded({ extended: true, limit: '3mb' }));

// Only your site(s) may call the API. Set ALLOWED_ORIGIN in Railway, e.g.
//   https://marinbando-afk.github.io
const allowed = (process.env.ALLOWED_ORIGIN || '*').split(',').map((s) => s.trim());
app.use(cors({ origin: allowed.includes('*') ? true : allowed }));

app.get('/api/health', (req, res) => res.json({ ok: true, ...warmStatus() }));

// Ads intelligence — a competitor's live ads from the Meta Ad Library (via Apify).
//   GET /api/ads?brand=The%20Oodie&country=AU  -> { count, ads: [{ text, image, page, started, link }] }
app.get('/api/ads', async (req, res) => {
  try {
    const data = await fetchAds(req.query.brand, req.query.country, req.query.force === '1');
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
    res.json(await fetchSocial(req.query.platform, req.query.handle, req.query.host));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
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
app.post('/api/chat', async (req, res) => {
  try {
    res.json(await chat(req.body));
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
    res.json({ insights: await getInsights(req.query.host, req.query.name, req.query.refresh === '1') });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// One-line marketing angle (+ how YOUR brand could apply it) for a single ad/post.
// Quick Anthropic balance probe (cached ~5 min) — so I can check if AI credits ran dry.
app.get('/api/credits', async (req, res) => { res.json(await creditStatus(req.query.fresh === '1')); });
app.post('/api/angle', async (req, res) => {
  try {
    const { text, kind, image, video } = req.body || {};
    const r = await quickAngle(text, kind, image, video);
    res.json({ angle: r.angle, hook: r.hook, creative: r.creative, apply: r.apply, script: r.script });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// "Your brand" knowledge base — scanned once, used to tailor every insight.
app.get('/api/my-brand', async (req, res) => {
  try { res.json({ brand: await getMyBrand() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/my-brand', async (req, res) => {
  try {
    const { name, website, mainProduct } = req.body || {};
    const brand = await setMyBrand(name, website, mainProduct);
    res.json({ brand });
    // Refresh tracked competitors' insights with the new brand context (best-effort, async).
    Promise.all((TRACKED || []).map((b) => generateInsights(b.name, b.host).catch(() => {}))).catch(() => {});
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.delete('/api/my-brand', async (req, res) => {
  try {
    await clearMyBrand();
    res.json({ ok: true });
    Promise.all((TRACKED || []).map((b) => generateInsights(b.name, b.host).catch(() => {}))).catch(() => {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Register a user-added competitor for the daily warm + kick off its first capture now.
app.post('/api/track', async (req, res) => {
  try {
    const { name, host, url, country, key } = req.body || {};
    const admin = !!(process.env.ADMIN_KEY && key === process.env.ADMIN_KEY);   // owner bypass
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
app.get('/api/shot', async (req, res) => {
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
    res.json(await signup(email, password));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
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
      'SELECT id, name, host, url, created_at FROM competitors WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.uid],
    );
    res.json({ competitors: r.rows });
  } catch (e) {
    res.status(500).json({ error: 'Could not load competitors.' });
  }
});

app.post('/api/competitors', requireAuth, async (req, res) => {
  try {
    const { name, host, url } = req.body || {};
    if (!name || !host || !url) return res.status(400).json({ error: 'Missing name, host, or url.' });
    const r = await pool.query(
      'INSERT INTO competitors(user_id, name, host, url) VALUES($1, $2, $3, $4) RETURNING id, name, host, url, created_at',
      [req.user.uid, String(name).slice(0, 120), String(host).slice(0, 200), String(url).slice(0, 500)],
    );
    res.json({ competitor: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: 'Could not save competitor.' });
  }
});

app.delete('/api/competitors/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM competitors WHERE id = $1 AND user_id = $2', [req.params.id, req.user.uid]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Could not remove competitor.' });
  }
});

const PORT = process.env.PORT || 3000;
function start() { app.listen(PORT, () => { console.log('✓ API listening on :' + PORT); startScheduler(); }); }
// Start the server no matter what — if the DB isn't wired yet, accounts are
// disabled but the ads endpoint still works.
initSchema().then(start).catch((err) => {
  console.warn('DB not ready — accounts disabled, ads still work:', err.message);
  start();
});
