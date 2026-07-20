// Daily per-channel snapshots — persisted so the chat (and the day-by-day
// history view) always have complete, fast data regardless of the in-memory cache.
// One row per (host, channel, day); same-day writes upsert.

import { pool } from './db.js';

const ok = () => !!process.env.DATABASE_URL;

// Reserved/internal snapshot buckets must NEVER be served through the public,
// unauthenticated history endpoints (/api/history, /api/snapshot): the cross-tenant
// competitor union (__tracked__) and each account's private brand profile (mybrand:<uid>)
// both live in this same table. A real competitor host is a bare public domain, so reject
// anything with a ':' (mybrand:*), any '__' bucket (__tracked__, __mybrand__), or anything
// not domain-shaped. Returning empty (not an error) keeps it indistinguishable from an
// unknown host, so it can't be used as a tenant-existence oracle either.
export function isPublicHost(h) {
  h = String(h || '').toLowerCase();
  if (!h || h.length > 255) return false;
  if (h.indexOf(':') >= 0 || h.indexOf('__') >= 0) return false;
  if (h.indexOf('.') < 0) return false;
  return /^[a-z0-9.-]+$/.test(h);
}

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
  if (!ok() || !host || !isPublicHost(host)) return [];
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

// All snapshots for one channel, OLDEST→NEWEST, each with its day string — used by
// one-time historical backfills that must walk and rewrite specific past days.
export async function allSnapshots(host, channel) {
  if (!ok() || !host) return [];
  try {
    // The NEWEST 60 days, returned oldest→newest (what every consumer expects). A plain
    // `ORDER BY day ASC LIMIT 60` returned the OLDEST 60 — fine for the first two months of
    // history, then the 14-day angle window and the sale-banner rotation guard would silently
    // start reading two-month-old data forever (audit timebomb, would have hit ~late Aug).
    const r = await pool.query(
      `SELECT day, data FROM (
         SELECT to_char(day,'YYYY-MM-DD') AS day, data, day AS d FROM snapshots
         WHERE host = $1 AND channel = $2 ORDER BY day DESC LIMIT 60
       ) t ORDER BY d ASC`,
      [String(host).toLowerCase(), channel],
    );
    return r.rows.map((x) => ({ day: x.day, data: x.data }));
  } catch (e) { return []; }
}

// Upsert a snapshot to a SPECIFIC day (not today). For historical backfills only —
// normal captures use saveSnapshot (CURRENT_DATE).
export async function saveSnapshotDay(host, channel, day, data) {
  if (!ok() || !host || !day || !data) return;
  try {
    await pool.query(
      `INSERT INTO snapshots(host, channel, day, data) VALUES($1, $2, $3::date, $4)
       ON CONFLICT (host, channel, day) DO UPDATE SET data = EXCLUDED.data, created_at = now()`,
      [String(host).toLowerCase(), channel, day, JSON.stringify(data)],
    );
  } catch (e) { console.warn('snapshot save-day ' + channel + ':', e.message); }
}

// All channels captured for a host on a given day.
export async function snapshotForDay(host, day) {
  if (!ok() || !host || !day || !isPublicHost(host)) return {};
  try {
    const r = await pool.query(
      `SELECT channel, data FROM snapshots WHERE host = $1 AND day = $2`,
      [String(host).toLowerCase(), day],
    );
    const out = {};
    // A channel is a real captured feed (ads/website/instagram/…). An UNDERSCORE-prefixed
    // channel is internal bookkeeping (e.g. _offerstate — which findings the Slack brief has
    // already announced), never a feed: it must not be served through this public,
    // unauthenticated endpoint. Same instinct as isPublicHost above, applied to channels.
    r.rows.forEach((x) => { if (!isInternalChannel(x.channel)) out[x.channel] = x.data; });
    return out;
  } catch (e) { return {}; }
}

// Internal, never-served snapshot buckets. See snapshotForDay.
export function isInternalChannel(c) { return String(c || '').startsWith('_'); }
