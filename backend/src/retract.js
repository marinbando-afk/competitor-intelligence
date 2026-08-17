// RETRACTIONS — removing provably-misattributed content from stored captures.
//
// R-RETRACT (founder, 14 Aug — the Liliana × Argentine-Bonafide ad): when content in a
// stored capture is PROVEN to belong to a different company, it does not get to live on
// as "history" — the app renders stored captures, so a misattributed ad keeps polluting
// the dossier (and the FOR YOU tip generated from it) until it is removed. A retraction
// is a data CORRECTION, not a re-capture, so it is exempt from the R-DAYLOCK write guard
// (which exists to stop partial-today data, not to preserve known-wrong data). Every
// retraction is declared here with its evidence, applied ONCE (marker state), logged,
// and followed by an insights regeneration so no read still quotes the retracted ad.

import { pool } from './db.js';

// Each retraction: an id (marker key), the host whose captures it cleans, and a per-ad
// predicate returning TRUE for ads that must be removed. Keep predicates narrow and
// evidence-backed — a retraction is a scalpel, never a filter.
export const RETRACTIONS = [
  {
    id: 'liliana-bonafide-2026-08',
    host: 'bonafideprovisions.com',
    // The Argentine Bonafide (chocolate) as branded-content partner on Liliana
    // Electrodomésticos' own MilkMaster ad — entered the Aug 12 capture through the
    // pairing door closed by R-TWIN-PAIR/R-PAIR-JUDGE.
    dropAd: (a) => /liliana/i.test(String((a && a.page) || '') + ' ' + String((a && a.landing) || '')),
  },
];

const MARKER_HOST = '__retract__';

export async function runRetractions() {
  let st = null;
  try { st = (await pool.query(`SELECT data FROM snapshots WHERE host = $1 AND channel = '_state' ORDER BY day DESC LIMIT 1`, [MARKER_HOST])).rows[0]; } catch (e) { return; }
  const done = (st && st.data && st.data.done) || {};
  let changed = false;
  for (const r of RETRACTIONS) {
    if (done[r.id]) continue;
    try {
      const rows = (await pool.query(`SELECT to_char(day,'YYYY-MM-DD') AS day, data FROM snapshots WHERE host = $1 AND channel = 'ads'`, [r.host])).rows;
      let removed = 0;
      for (const row of rows) {
        const ads = (row.data && row.data.ads) || [];
        const kept = ads.filter((a) => !r.dropAd(a));
        if (kept.length !== ads.length) {
          removed += ads.length - kept.length;
          const next = { ...row.data, ads: kept };
          await pool.query(`UPDATE snapshots SET data = $3 WHERE host = $1 AND channel = 'ads' AND day = $2::date`, [r.host, row.day, JSON.stringify(next)]);
        }
      }
      done[r.id] = new Date().toISOString().slice(0, 10) + ' — removed ' + removed + ' ad(s)';
      changed = true;
      console.log('✓ retraction ' + r.id + ': removed ' + removed + ' misattributed ad(s) from ' + r.host);
      if (removed) {
        // Regenerate the read so no surface still quotes the retracted ad (incl. FOR YOU).
        try {
          const { generateInsights } = await import('./insights.js');
          const t = (await pool.query(`SELECT name FROM competitors WHERE host = $1 LIMIT 1`, [r.host])).rows[0];
          await generateInsights((t && t.name) || r.host, r.host);
          console.log('✓ retraction ' + r.id + ': insights regenerated for ' + r.host);
        } catch (e) { console.warn('retraction regen ' + r.host + ':', e.message); }
      }
    } catch (e) { console.warn('retraction ' + r.id + ':', e.message); }
  }
  if (changed) {
    try {
      await pool.query(
        `INSERT INTO snapshots(host, channel, day, data) VALUES($1, '_state', CURRENT_DATE, $2)
         ON CONFLICT (host, channel, day) DO UPDATE SET data = EXCLUDED.data, created_at = now()`,
        [MARKER_HOST, JSON.stringify({ done })],
      );
    } catch (e) { console.warn('retraction marker:', e.message); }
  }
}
