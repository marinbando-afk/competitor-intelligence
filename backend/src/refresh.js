// Daily pre-warm — scrapes every tracked competitor's ads + social in the
// background so the report is already waiting when the user opens the app
// (no spinner, no cold-start timeouts on the slow scrapers like TikTok).
//
// Schedule is configurable in Railway:
//   CRON_HOUR  hour of day to refresh (0–23, default 5 = 5am)
//   CRON_TZ    IANA timezone for that hour (default UTC), e.g. "Australia/Sydney"

import { fetchAds } from './ads.js';
import { fetchSocial } from './social.js';
import { getEmails } from './email.js';
import { captureWebsiteFull } from './website.js';
import { generateInsights } from './insights.js';
import { postDigest } from './slack.js';
import { saveSnapshot, latestSnapshot } from './snapshots.js';

// Brands kept permanently warm (mirrors the app's seeded demos).
export const TRACKED = [
  { name: 'The Oodie', host: 'theoodie.com', country: 'AU', handles: { ig: 'the_oodie', tt: 'the_oodie', fb: 'theofficialoodie' } },
  { name: 'Ancestral Cosmetics', host: 'ancestralcosmetics.com', country: 'ALL', handles: { ig: 'ancestralskin', tt: 'ancestralskin', fb: 'ancestralskin' } },
];

const PLATFORMS = [['instagram', 'ig'], ['tiktok', 'tt'], ['facebook', 'fb']];

// Competitors the user added in the app — persisted as a singleton list so the
// daily warm covers them too (the seeded demos live in TRACKED above).
const TKEY = '__tracked__';
// Plan limit: how many USER-ADDED competitors the daily warm covers (the seeded
// demos in TRACKED are always on). Free = 0; bump MAX_USER_BRANDS env on upgrade.
const MAX_USER = Number(process.env.MAX_USER_BRANDS) || 0;
function cleanHost(h) { return String(h || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '').toLowerCase(); }

export async function getTracked() {
  const d = await latestSnapshot(TKEY, 'list');
  return (d && Array.isArray(d.items)) ? d.items : [];
}
export async function addTracked(comp, admin) {
  const host = cleanHost(comp && (comp.host || comp.url));
  if (!host || host.indexOf('.') < 0) return null;
  if (TRACKED.some((t) => t.host === host)) return { existing: true };   // already a warm demo
  const items = await getTracked();
  if (items.some((t) => t.host === host)) return { existing: true };
  if (!admin && items.length >= MAX_USER) return { limited: true, max: MAX_USER };   // plan limit (owner bypasses)
  const norm = { name: String(comp.name || host).slice(0, 120), host, url: comp.url || ('https://' + host), country: String(comp.country || 'ALL').toUpperCase(), handles: comp.handles || {} };
  items.push(norm);
  await saveSnapshot(TKEY, 'list', { items: items.slice(-200) });
  return { added: true, comp: norm };
}
export async function allBrands() {
  const seen = new Set(TRACKED.map((t) => t.host));
  return TRACKED.concat((await getTracked()).filter((t) => t && t.host && !seen.has(t.host)));
}

let running = false;
let lastWarm = null, lastResult = null;
export function warmStatus() { return { warmedAt: lastWarm, last: lastResult, running, tracked: TRACKED.length }; }

// One brand's full capture: ads + social + email + website + insights.
export async function warmBrand(b, force) {
  let ok = 0, fail = 0;
  try { const a = await fetchAds(b.name, b.country, force); ok++; if (a && a.ads && a.ads.length) await saveSnapshot(b.host, 'ads', a); }
  catch (e) { fail++; console.warn('warm ads ' + b.name + ':', e.message); }
  for (const [pf, hk] of PLATFORMS) {
    try { const s = await fetchSocial(pf, b.handles && b.handles[hk], b.host, force); ok++; if (s && s.posts && s.posts.length) await saveSnapshot(b.host, pf, s); }
    catch (e) { fail++; console.warn('warm ' + pf + ' ' + b.name + ':', e.message); }
  }
  try { const em = await getEmails(b.host); if (em && em.storage) await saveSnapshot(b.host, 'email', em); } catch (e) { /* best-effort */ }
  try { await captureWebsiteFull(b.host, b.url || ('https://' + b.host)); ok++; } catch (e) { fail++; console.warn('warm website ' + b.name + ':', e.message); }
  try { await generateInsights(b.name, b.host); ok++; } catch (e) { fail++; console.warn('warm insights ' + b.name + ':', e.message); }
  return { ok, fail };
}

export async function refreshAll(force) {
  if (running) { console.log('refresh already in progress — skipping'); return { skipped: true }; }
  running = true;
  const t0 = Date.now();
  let ok = 0, fail = 0, brands = [];
  try {
    brands = await allBrands();
    for (const b of brands) { const r = await warmBrand(b, force); ok += r.ok; fail += r.fail; }
  } finally {
    running = false;
  }
  lastWarm = Date.now();
  lastResult = { ok, fail };
  console.log('✓ pre-warm done: ' + ok + ' ok, ' + fail + ' failed in ' + Math.round((Date.now() - t0) / 1000) + 's');
  // Daily brief to Slack — scheduled run only, and only for the user's REAL competitors.
  // The seeded DEMO brands (TRACKED) are showcase data, so they're never sent to Slack.
  if (force) {
    const clientBrands = brands.filter((b) => !TRACKED.some((t) => t.host === b.host));
    if (clientBrands.length) postDigest(clientBrands).then((r) => console.log('slack digest:', JSON.stringify(r))).catch(() => {});
  }
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
