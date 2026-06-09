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

const app = express();
app.use(express.json());

// Only your site(s) may call the API. Set ALLOWED_ORIGIN in Railway, e.g.
//   https://marinbando-afk.github.io
const allowed = (process.env.ALLOWED_ORIGIN || '*').split(',').map((s) => s.trim());
app.use(cors({ origin: allowed.includes('*') ? true : allowed }));

app.get('/api/health', (req, res) => res.json({ ok: true }));

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
initSchema()
  .then(() => app.listen(PORT, () => console.log(`✓ API listening on :${PORT}`)))
  .catch((err) => {
    console.error('DB init failed:', err.message);
    process.exit(1);
  });
