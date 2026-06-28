// Feature requests / feedback from users — stored in Postgres. The owner reads
// them via GET /api/feedback?key=ADMIN_KEY (same owner key that lifts plan limits).

import { pool } from './db.js';

const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

export async function storeFeedback(body) {
  const message = clean(body && body.message).slice(0, 4000);
  if (!message) { const e = new Error('Write a message first.'); e.status = 400; throw e; }
  if (!process.env.DATABASE_URL) return { ok: true, stored: false };
  await pool.query(
    'INSERT INTO feedback(name, email, message) VALUES($1, $2, $3)',
    [clean(body.name).slice(0, 160), clean(body.email).slice(0, 200), message],
  );
  return { ok: true, stored: true };
}

export async function listFeedback() {
  if (!process.env.DATABASE_URL) return [];
  const r = await pool.query(
    'SELECT id, name, email, message, created_at FROM feedback ORDER BY created_at DESC LIMIT 300',
  );
  return r.rows;
}
