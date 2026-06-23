// Daily pre-warm — scrapes every tracked competitor's ads + social in the
// background so the report is already waiting when the user opens the app
// (no spinner, no cold-start timeouts on the slow scrapers like TikTok).
//
// Schedule is configurable in Railway:
//   CRON_HOUR  hour of day to refresh (0–23, default 5 = 5am)
//   CRON_TZ    IANA timezone for that hour (default UTC), e.g. "Australia/Sydney"

import { fetchAds } from './ads.js';
import { fetchSocial } from './social.js';
import { saveSnapshot } from './snapshots.js';

// Brands kept permanently warm (mirrors the app's seeded demos).
export const TRACKED = [
  { name: 'The Oodie', host: 'theoodie.com', country: 'AU', handles: { ig: 'the_oodie', tt: 'the_oodie', fb: 'theofficialoodie' } },
  { name: 'Ancestral Cosmetics', host: 'ancestralcosmetics.com', country: 'ALL', handles: { ig: 'ancestralskin', tt: 'ancestralskin', fb: 'ancestralskin' } },
];

const PLATFORMS = [['instagram', 'ig'], ['tiktok', 'tt'], ['facebook', 'fb']];

let running = false;
let lastWarm = null, lastResult = null;

export function warmStatus() { return { warmedAt: lastWarm, last: lastResult, running, tracked: TRACKED.length }; }

export async function refreshAll(force) {
  if (running) { console.log('refresh already in progress — skipping'); return { skipped: true }; }
  running = true;
  const t0 = Date.now();
  let ok = 0, fail = 0;
  try {
    for (const b of TRACKED) {
      try { const a = await fetchAds(b.name, b.country, force); ok++; if (a && a.ads && a.ads.length) await saveSnapshot(b.host, 'ads', a); }
      catch (e) { fail++; console.warn('warm ads ' + b.name + ':', e.message); }
      for (const [pf, hk] of PLATFORMS) {
        try { const s = await fetchSocial(pf, b.handles && b.handles[hk], b.host, force); ok++; if (s && s.posts && s.posts.length) await saveSnapshot(b.host, pf, s); }
        catch (e) { fail++; console.warn('warm ' + pf + ' ' + b.name + ':', e.message); }
      }
    }
  } finally {
    running = false;
  }
  lastWarm = Date.now();
  lastResult = { ok, fail };
  console.log('✓ pre-warm done: ' + ok + ' ok, ' + fail + ' failed in ' + Math.round((Date.now() - t0) / 1000) + 's');
  return { ok, fail };
}

// ms until the next HH:00 in the given IANA timezone (dependency-free, DST-safe).
function msUntil(hour, tz) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date());
  const val = (t) => parseInt(parts.find((p) => p.type === t).value, 10);
  const secsNow = (val('hour') % 24) * 3600 + val('minute') * 60 + val('second');
  let diff = hour * 3600 - secsNow;
  if (diff <= 0) diff += 86400;
  return diff * 1000;
}

export function startScheduler() {
  const hour = Math.min(23, Math.max(0, parseInt(process.env.CRON_HOUR || '5', 10)));
  const tz = process.env.CRON_TZ || 'UTC';

  function arm() {
    const ms = msUntil(hour, tz);
    console.log('next daily pre-warm in ' + (Math.round(ms / 360000) / 10) + 'h (' + hour + ':00 ' + tz + ')');
    setTimeout(() => { refreshAll(true).catch(() => {}); arm(); }, ms);
  }
  arm();

  // Warm shortly after boot so a fresh deploy is never cold.
  setTimeout(() => refreshAll(false).catch(() => {}), 15000);
}
