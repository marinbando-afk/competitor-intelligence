// Public system stats — REAL counts from the capture database, for the landing page's
// proof band. Nothing here is invented or incremented on a timer: every number is a
// SQL aggregate over what the system actually captured. Cached ~10 min to keep it cheap.
//
//   GET /api/stats -> { available, signals, adsDecoded, postsCaptured, emailsCaptured, capturesRun }

import { pool } from './db.js';

let _c = { at: 0, val: null };

export async function systemStats() {
  if (_c.val && Date.now() - _c.at < 10 * 60 * 1000) return _c.val;
  if (!process.env.DATABASE_URL) return { available: false };
  const num = async (sql) => {
    try { const r = await pool.query(sql); return Number(r.rows[0].n) || 0; } catch (e) { return 0; }
  };
  // Each daily capture re-reads the live set, so summing across days counts real reads.
  const adsDecoded = await num(`SELECT COALESCE(SUM(jsonb_array_length(data->'ads')),0) AS n FROM snapshots WHERE channel='ads' AND jsonb_typeof(data->'ads')='array'`);
  const postsCaptured = await num(`SELECT COALESCE(SUM(jsonb_array_length(data->'posts')),0) AS n FROM snapshots WHERE channel IN ('instagram','tiktok','facebook') AND jsonb_typeof(data->'posts')='array'`);
  const emailsCaptured = await num(`SELECT COUNT(*) AS n FROM emails`);
  const capturesRun = await num(`SELECT COUNT(*) AS n FROM snapshots`);
  const val = {
    available: true,
    adsDecoded,
    postsCaptured,
    emailsCaptured,
    capturesRun,
    signals: adsDecoded + postsCaptured + emailsCaptured,
  };
  _c = { at: Date.now(), val };
  return val;
}
