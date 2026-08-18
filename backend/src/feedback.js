// Feature requests / feedback from users — stored in Postgres. The owner reads
// them via GET /api/feedback?key=ADMIN_KEY (same owner key that lifts plan limits).

import { pool } from './db.js';

const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

export async function storeFeedback(body) {
  const message = clean(body && body.message).slice(0, 4000);
  if (!message) { const e = new Error('Write a message first.'); e.status = 400; throw e; }
  // Optional screenshot — a resized JPEG/PNG data URL (the client shrinks it before upload).
  let image = String((body && body.image) || '');
  if (!/^data:image\/(png|jpe?g|webp|gif);base64,/.test(image) || image.length > 2600000) image = ''; // ~2MB cap; ignore anything that isn't a small inline image
  if (!process.env.DATABASE_URL) return { ok: true, stored: false };
  const name = clean(body.name).slice(0, 160), email = clean(body.email).slice(0, 200);
  await pool.query(
    'INSERT INTO feedback(name, email, message, image) VALUES($1, $2, $3, $4)',
    [name, email, message, image || null],
  );
  notifyContact({ name, email, message });   // fire-and-forget — the DB row above is the source of truth
  return { ok: true, stored: true };
}

// Email ping to the founder's inbox for every contact/feedback submission (founder,
// 13 Aug: the contact box "sends to info@watchback.ai"). Dormant until RESEND_API_KEY
// is set in Railway — same wake-on-env pattern as Stripe. Plain HTTPS call, no package.
async function notifyContact(row) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.CONTACT_FROM || 'WatchBack <contact@watchback.ai>',
        to: [process.env.CONTACT_EMAIL || 'info@watchback.ai'],
        reply_to: row.email || undefined,
        subject: '📨 WatchBack contact — ' + (row.email || 'no email left'),
        text: (row.name ? row.name + '\n' : '') + (row.email ? row.email + '\n\n' : '\n') + row.message,
      }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) { console.warn('[contact-mail]', (e && e.message) || e); }
}

export async function listFeedback() {
  if (!process.env.DATABASE_URL) return [];
  const r = await pool.query(
    'SELECT id, name, email, message, image, created_at FROM feedback ORDER BY created_at DESC LIMIT 300',
  );
  return r.rows;
}
