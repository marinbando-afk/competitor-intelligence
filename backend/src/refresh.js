// Daily pre-warm — scrapes every tracked competitor's ads + social in the
// background so the report is already waiting when the user opens the app
// (no spinner, no cold-start timeouts on the slow scrapers like TikTok).
//
// Schedule is configurable in Railway (all hours 0–23 in CRON_TZ):
//   WARM_HOUR  when the NIGHTLY capture runs (default 23 = 11pm) — end of day, so each
//              snapshot holds a full day of the competitor's activity.
//   BRIEF_HOUR when the MORNING brief is sent (default 8 = 8am) — reads that night's snapshot,
//              so a brief covers a complete calendar day, not a 7am-to-7am window.
//   CRON_TZ    IANA timezone for those hours (default the founder's local zone below).

import { fetchAds } from './ads.js';
import { fetchSocial } from './social.js';
import { getEmails } from './email.js';
import { captureWebsiteFull } from './website.js';
import { generateInsights, enrichCreativeHooks, creditStatus } from './insights.js';
import { saveSnapshot, latestSnapshot } from './snapshots.js';
import { pool } from './db.js';
import { ensureWeeklies } from './weekly.js';
import { postText, postDailyBrief, sendUserDailyBriefs, sendUserWeeklyLinks } from './slack.js';

// The founder's local timezone — the daily "day" boundary is anchored here so the brief lines
// up with their calendar day. Override with CRON_TZ in Railway (e.g. a client's own zone).
const DEFAULT_TZ = 'Europe/Zagreb';

// Brands kept permanently warm (mirrors the app's seeded demos).
export const TRACKED = [
  { name: 'The Oodie', host: 'theoodie.com', country: 'AU', handles: { ig: 'the_oodie', tt: 'the_oodie', fb: 'theofficialoodie' } },
  { name: 'Liquid Death', host: 'liquiddeath.com', country: 'US', handles: { ig: 'liquiddeath', tt: 'liquiddeath', fb: 'liquiddeath' } },
  { name: 'Smooche', host: 'smooche.com', country: 'US', handles: { ig: 'smooche', tt: 'smooche.com', fb: 'profile.php?id=100067470427617' } },
];

const PLATFORMS = [['instagram', 'ig'], ['tiktok', 'tt'], ['facebook', 'fb']];

// Competitors the user added in the app — persisted as a singleton list so the
// daily warm covers them too (the seeded demos live in TRACKED above).
const TKEY = '__tracked__';
// How many USER-ADDED competitors the daily 5am warm covers (the seeded demos in TRACKED
// are always on). Was 0 (no user brand pre-warmed → every view did a live 35-63s scrape and
// the founder's competitors were never refreshed overnight). Founder wants them preloaded
// daily (17 Jul), so the default is now a generous bound that covers the private beta; raise
// MAX_USER_BRANDS on Railway if the watch-list ever outgrows it. `>= 0` guard so an explicit
// env of 0 is still honoured.
const _maxUserEnv = Number(process.env.MAX_USER_BRANDS);
const MAX_USER = Number.isFinite(_maxUserEnv) ? _maxUserEnv : 25;   // founder-set cost ceiling (20 Jul); raise via MAX_USER_BRANDS env when the client base outgrows it
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
// Drop a host from the daily warm (called when the LAST customer tracking it deletes
// it — otherwise the nightly scrape keeps paying for a brand nobody watches).
export async function removeTracked(host) {
  host = cleanHost(host);
  if (!host) return { removed: false };
  const items = await getTracked();
  const next = items.filter((t) => t.host !== host);
  if (next.length === items.length) return { removed: false };
  await saveSnapshot(TKEY, 'list', { items: next });
  return { removed: true };
}
// Global warm-list usage vs the MAX_USER_BRANDS ceiling. Per-account limits govern what
// each customer may add; this is the overall cost backstop — surfaced in the admin panel
// so raising a client's limit can't silently fail to enrol (and scrape) their brand.
export async function warmUsage() {
  try { return { used: (await getTracked()).length, cap: MAX_USER }; }
  catch (e) { return { used: 0, cap: MAX_USER }; }
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
  // Creative-hook budgets (separate so neither starves the other): ADS get full coverage;
  // SOCIAL gets its top-N recent posts per platform (organic captions already carry most of a
  // post's hook, and posts are numerous — this keeps the vision cost within ~$2/mo/competitor).
  // Both are cached per creative, so only genuinely NEW creatives cost a vision call.
  const adBudget = { left: Number(process.env.AD_HOOK_CAP) || 40 };
  const socialBudget = { left: Number(process.env.SOCIAL_HOOK_CAP) || 18 };
  const POST_PER = Number(process.env.SOCIAL_HOOK_PER) || 6;
  try { const a = await fetchAds(b.name, b.country, force, false, b.host); ok++; if (a && a.ads && a.ads.length) { await enrichCreativeHooks(b.host, 'ads', 'ad', a.ads, adBudget); await saveSnapshot(b.host, 'ads', a); } }
  catch (e) { fail++; console.warn('warm ads ' + b.name + ':', e.message); }
  for (const [pf, hk] of PLATFORMS) {
    try {
      const s = await fetchSocial(pf, b.handles && b.handles[hk], b.host, force); ok++;
      if (s && s.posts && s.posts.length) {
        const top = [...s.posts].sort((x, y) => String(y.date || '').localeCompare(String(x.date || ''))).slice(0, POST_PER);   // enrich the newest posts (refs into s.posts, so hooks land on the saved objects)
        await enrichCreativeHooks(b.host, pf, 'post', top, socialBudget);
        await saveSnapshot(b.host, pf, s);
      }
    } catch (e) { fail++; console.warn('warm ' + pf + ' ' + b.name + ':', e.message); }
  }
  try { const em = await getEmails(b.host, b.name); if (em && em.storage) await saveSnapshot(b.host, 'email', em); } catch (e) { /* best-effort */ }
  try { await captureWebsiteFull(b.host, b.url || ('https://' + b.host)); ok++; } catch (e) { fail++; console.warn('warm website ' + b.name + ':', e.message); }
  // Insights live in ONE shared per-host snapshot that every co-watching account (and
  // anonymous demo/report visitors) reads, so they're generated tenant-neutral — the
  // "apply" tips use the default illustrative brand, never a customer's private one.
  try { await generateInsights(b.name, b.host); ok++; } catch (e) { fail++; console.warn('warm insights ' + b.name + ':', e.message); }
  // Advance every customer's row for this host: fresh capture = status 'watching' and
  // updated_at = capture time, so the app's "scanned X ago" reflects DATA freshness,
  // not when the user last edited the competitor.
  try {
    if (process.env.DATABASE_URL) await pool.query(`UPDATE competitors SET status = 'watching', updated_at = now() WHERE host = $1`, [b.host]);
  } catch (e) { /* best-effort */ }
  return { ok, fail };
}

// Self-healing enrolment: reconcile the warm list against what customers ACTUALLY have.
// - Adds competitor hosts that never made it in (e.g. added while MAX_USER_BRANDS was 0,
//   or a track call that failed) — up to the cap.
// - Prunes entries no customer has anymore (deleted competitors, old test brands) so we
//   never pay to scrape a brand nobody is watching.
async function syncTracked() {
  if (!process.env.DATABASE_URL) return;
  try {
    const items = await getTracked();
    const r = await pool.query('SELECT DISTINCT host FROM competitors');
    const wanted = new Set(r.rows.map((x) => cleanHost(x.host)).filter(Boolean));
    const demo = new Set(TRACKED.map((t) => t.host));
    const next = items.filter((t) => wanted.has(t.host));
    for (const h of wanted) {
      if (demo.has(h) || next.some((t) => t.host === h)) continue;
      if (next.length >= MAX_USER) { console.warn('syncTracked: cap reached, not enrolling ' + h); continue; }
      const c = await pool.query('SELECT name, host, url, country, handles FROM competitors WHERE host = $1 ORDER BY created_at ASC LIMIT 1', [h]);
      if (c.rows[0]) next.push({ name: String(c.rows[0].name || h).slice(0, 120), host: h, url: c.rows[0].url || ('https://' + h), country: String(c.rows[0].country || 'ALL').toUpperCase(), handles: c.rows[0].handles || {} });
    }
    if (JSON.stringify(next) !== JSON.stringify(items)) {
      await saveSnapshot(TKEY, 'list', { items: next.slice(-200) });
      console.log('✓ syncTracked: warm list reconciled — ' + items.length + ' → ' + next.length + ' user brand(s)');
    }
  } catch (e) { console.warn('syncTracked:', e.message); }
}

export async function refreshAll(force) {
  if (running) { console.log('refresh already in progress — skipping'); return { skipped: true }; }
  running = true;
  const t0 = Date.now();
  let ok = 0, fail = 0, skipped = 0, brands = [];
  try {
    await syncTracked();
    brands = await allBrands();
    const today = new Date().toISOString().slice(0, 10);
    for (const b of brands) {
      // NON-FORCE runs (the boot warm 15s after every deploy) SKIP brands already captured
      // today — the audit's #1 cost finding: every deploy re-ran the whole paid pipeline
      // (Apify ads + 3 social scrapes + screenshots + Sonnet insights, per brand) because the
      // freshness caches are in-memory and die with the process. The snapshot table is the
      // durable freshness record, so consult IT. The nightly 23:00 warm passes force=true and
      // still re-captures everything (end-of-day state, by design).
      if (!force) {
        try {
          const r0 = await pool.query(`SELECT 1 FROM snapshots WHERE host = $1 AND day = $2 AND channel = 'website' LIMIT 1`, [b.host, today]);
          if (r0.rows[0]) { skipped++; continue; }
        } catch (e) { /* no DB → warm as before */ }
      }
      const r = await warmBrand(b, force); ok += r.ok; fail += r.fail;
    }
    if (skipped) console.log('✓ warm: skipped ' + skipped + ' brand(s) already captured today (deploy re-warm guard)');
  } finally {
    running = false;
  }
  lastWarm = Date.now();
  lastResult = { ok, fail };
  console.log('✓ nightly capture done: ' + ok + ' ok, ' + fail + ' failed in ' + Math.round((Date.now() - t0) / 1000) + 's');
  // RETENTION (audit: snapshots grow unbounded at ~200-400KB/host/day, mostly base64 shots in
  // JSONB). Keep the DATA (summaries/diffs/posts) forever — only the heavy blobs age out:
  // screenshots after 90 days, raw email HTML after 6 months. Runs after the nightly warm.
  if (force && process.env.DATABASE_URL) {
    try {
      const a = await pool.query(`UPDATE snapshots SET data = (data - 'shot') - 'changedShots' WHERE channel = 'website' AND day < CURRENT_DATE - 90 AND (data ? 'shot' OR data ? 'changedShots')`);
      const b = await pool.query(`UPDATE emails SET html = NULL WHERE received_at < now() - interval '6 months' AND html IS NOT NULL`);
      if (a.rowCount || b.rowCount) console.log('✓ retention: stripped ' + a.rowCount + ' old screenshot day(s), ' + b.rowCount + ' old email body(ies)');
    } catch (e) { console.warn('retention:', e.message); }
  }
  // NOTE: the daily Slack brief + weekly reports are NO LONGER sent from here. Capture runs at
  // END OF DAY so each snapshot holds a COMPLETE day; the brief is sent separately the next
  // MORNING (sendDailyDigest) reading that night's snapshot — so a brief covers a full calendar
  // day instead of the old 7am-to-7am window that split every day in half. (founder, 19 Jul)
  return { ok, fail };
}

// Send the daily Slack briefs + weekly reports from the LATEST captured snapshots — NO scraping.
// Runs in the morning; the snapshots it reads were taken at end-of-day by refreshAll, so each
// brief reflects a full day of competitor activity.
export async function sendDailyDigest() {
  // ALERTING (audit: the credit probe existed but nothing ever called it — empty Anthropic
  // credits meant silently blank AI reads until the founder noticed). One check per morning,
  // straight to the founder's Slack.
  try {
    const c = await creditStatus(true);
    if (c && c.ok === false && c.empty) postText('🚨 *Anthropic API credits are EMPTY* — all AI reads (insights, chat, weekly reports) are failing silently. Top up at console.anthropic.com → Billing.').catch(() => {});
  } catch (e) { /* the probe must never block the briefs */ }
  let brands = [];
  try { brands = await allBrands(); } catch (e) { console.warn('digest allBrands:', e.message); return; }
  const clientBrands = brands.filter((b) => !TRACKED.some((t) => t.host === b.host));   // demos never go to Slack
  if (clientBrands.length) postDailyBrief(clientBrands).then((r) => console.log('slack daily brief:', JSON.stringify(r))).catch(() => {});
  sendUserDailyBriefs(pool).catch(() => {});   // each customer's own competitors → their own Slack
  // Weekly reports: Monday regenerates the completed week for every brand; other days backfill
  // a current-week draft for brands that don't have one yet.
  try {
    const isMonday = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: process.env.CRON_TZ || DEFAULT_TZ }).format(new Date()) === 'Mon';
    const made = await ensureWeeklies(brands, isMonday);
    if (isMonday && made.length) {
      const label = made[0].week.label;
      postText('📊 *Weekly competitor reports are ready* (' + label + '):\n' +
        made.map((m) => '• ' + m.brand + ' — https://watchback.ai/report.html?host=' + m.host).join('\n')).catch(() => {});
      sendUserWeeklyLinks(pool, label).catch(() => {});   // each customer's own report links → their own Slack
    }
  } catch (e) { console.warn('weeklies:', e.message); }
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
  const tz = process.env.CRON_TZ || DEFAULT_TZ;
  const clampHour = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(23, Math.max(0, n)) : d; };
  // Capture at END of day so each snapshot holds a full day; send the brief the next MORNING.
  const warmHour = clampHour(process.env.WARM_HOUR, 23);
  const briefHour = clampHour(process.env.BRIEF_HOUR || process.env.CRON_HOUR, 8);
  const fmtH = (ms) => (Math.round(ms / 360000) / 10) + 'h';

  function armWarm() {
    const ms = msUntil(warmHour, tz);
    console.log('next nightly capture in ' + fmtH(ms) + ' (' + warmHour + ':00 ' + tz + ')');
    setTimeout(() => { refreshAll(true).catch(() => {}); armWarm(); }, ms);
  }
  function armBrief() {
    const ms = msUntil(briefHour, tz);
    console.log('next morning brief in ' + fmtH(ms) + ' (' + briefHour + ':00 ' + tz + ')');
    setTimeout(() => { sendDailyDigest().catch(() => {}); armBrief(); }, ms);
  }
  armWarm();
  armBrief();

  // Warm shortly after boot so a fresh deploy is never cold (capture only — never sends a brief).
  setTimeout(() => refreshAll(false).catch(() => {}), 15000);
}
