// Daily per-channel snapshots — persisted so the chat (and the day-by-day
// history view) always have complete, fast data regardless of the in-memory cache.
// One row per (host, channel, day); same-day writes upsert.

import { pool } from './db.js';

const ok = () => !!process.env.DATABASE_URL;

export async function saveSnapshot(host, channel, data) {
  if (!ok() || !host || !data) return;
  try {
    await pool.query(
      `INSERT INTO snapshots(host, channel, day, data) VALUES($1, $2, CURRENT_DATE, $3)
       ON CONFLICT (host, channel, day) DO UPDATE SET data = EXCLUDED.data, created_at = now()`,
      [String(host).toLowerCase(), channel, JSON.stringify(data)],
    );
  } catch (e) { console.warn('snapshot save ' + channel + ':', e.message); }
}

// Most recent snapshot for a channel (any day).
export async function latestSnapshot(host, channel) {
  if (!ok() || !host) return null;
  try {
    const r = await pool.query(
      `SELECT data, day FROM snapshots WHERE host = $1 AND channel = $2 ORDER BY day DESC LIMIT 1`,
      [String(host).toLowerCase(), channel],
    );
    if (!r.rows[0]) return null;
    const d = r.rows[0].data;
    if (d && typeof d === 'object') d.__day = r.rows[0].day;
    return d;
  } catch (e) { return null; }
}

// Distinct days we have any snapshot for (newest first) — powers the date switcher.
export async function snapshotDays(host) {
  if (!ok() || !host) return [];
  try {
    const r = await pool.query(
      `SELECT DISTINCT day FROM snapshots WHERE host = $1 ORDER BY day DESC LIMIT 60`,
      [String(host).toLowerCase()],
    );
    return r.rows.map((x) => x.day);
  } catch (e) { return []; }
}

// The most recent snapshots for one channel (newest first, one per day) —
// powers the website before/after comparison.
export async function recentSnapshots(host, channel, limit) {
  if (!ok() || !host) return [];
  try {
    const r = await pool.query(
      `SELECT to_char(day,'YYYY-MM-DD') AS day, data FROM snapshots
       WHERE host = $1 AND channel = $2 ORDER BY day DESC LIMIT $3`,
      [String(host).toLowerCase(), channel, Math.min(20, limit || 5)],
    );
    return r.rows.map((x) => ({ day: x.day, data: x.data }));
  } catch (e) { return []; }
}

// All channels captured for a host on a given day.
export async function snapshotForDay(host, day) {
  if (!ok() || !host || !day) return {};
  try {
    const r = await pool.query(
      `SELECT channel, data FROM snapshots WHERE host = $1 AND day = $2`,
      [String(host).toLowerCase(), day],
    );
    const out = {};
    r.rows.forEach((x) => { out[x.channel] = x.data; });
    return out;
  } catch (e) { return {}; }
}
