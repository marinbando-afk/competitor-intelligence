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
import { fetchAds } from './ads.js';
import { fetchSocial } from './social.js';
import { startScheduler, warmStatus } from './refresh.js';
import { storeInbound, getEmails, recentEmails } from './email.js';
import { chat } from './chat.js';

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
    res.json(await fetchAds(req.query.brand, req.query.country));
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

// AI chat — answer a question grounded in a competitor's captured data.
app.post('/api/chat', async (req, res) => {
  try {
    res.json(await chat(req.body));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
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
