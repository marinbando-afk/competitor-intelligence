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
import { fetchSocial, resolveHandles } from './social.js';
import { getEmails } from './email.js';
import { captureWebsiteFull } from './website.js';
import { generateInsights, enrichCreativeHooks, creditStatus } from './insights.js';
import { saveSnapshot, latestSnapshot, setNightlyAuthoritative } from './snapshots.js';
import { resolveLandings } from './landcheck.js';
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
const MAX_USER = Number.isFinite(_maxUserEnv) ? _maxUserEnv : 30;   // founder-set cost ceiling (raised 25→30, 22 Jul); MAX_USER_BRANDS env still overrides
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
  // SELF-HEAL empty handles (found 23 Jul — Tallowed Truth had handles:{} since being added,
  // so no platform was EVER scraped): re-resolve from their site once per warm and persist to
  // every account's row for this host, so social scraping starts without anyone noticing.
  if (!b.handles || !Object.keys(b.handles).length) {
    try {
      const h = await resolveHandles(b.host);
      if (h && Object.keys(h).length) {
        b.handles = h;
        if (process.env.DATABASE_URL) await pool.query(`UPDATE competitors SET handles = $2 WHERE host = $1 AND (handles IS NULL OR handles::text = '{}')`, [b.host, JSON.stringify(h)]);
        // …and the warm list itself, so tomorrow's warm starts with the healed handles.
        try { const items = await getTracked(); const it = items.find((t) => t.host === b.host); if (it && (!it.handles || !Object.keys(it.handles).length)) { it.handles = h; await saveSnapshot(TKEY, 'list', { items }); } } catch (e) { /* rows are healed regardless */ }
        console.log('✓ self-healed handles for ' + b.host + ': ' + JSON.stringify(h));
      }
    } catch (e) { /* next warm retries */ }
  }
  // Creative-hook budgets (separate so neither starves the other): ADS get full coverage;
  // SOCIAL gets its top-N recent posts per platform (organic captions already carry most of a
  // post's hook, and posts are numerous — this keeps the vision cost within ~$2/mo/competitor).
  // Both are cached per creative, so only genuinely NEW creatives cost a vision call.
  const adBudget = { left: Number(process.env.AD_HOOK_CAP) || 40 };
  const socialBudget = { left: Number(process.env.SOCIAL_HOOK_CAP) || 18 };
  const POST_PER = Number(process.env.SOCIAL_HOOK_PER) || 6;
  try { const a = await fetchAds(b.name, b.country, force, false, b.host); ok++; if (a && a.ads && a.ads.length) { await enrichCreativeHooks(b.host, 'ads', 'ad', a.ads, adBudget); try { const L = await resolveLandings(a.ads); if (L) a.landings = L; } catch (e) { console.warn('[landcheck]', b.host, (e && e.message) || e); } await saveSnapshot(b.host, 'ads', a); } }
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
    // R-DAYLOCK-NIGHTLY: the forced 23:00 run is the authoritative end-of-day capture and
    // may overwrite a same-day boot-warm row (with substantive data only). Boot warms and
    // on-demand runs stay non-authoritative and respect the day-lock as before.
    if (force) setNightlyAuthoritative(true);
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
    setNightlyAuthoritative(false);
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

// ── NIGHTLY QUALITY AUDIT ─────────────────────────────────────────────────────
// "Why do I have to ask the same questions every day?" (founder, 4 Aug). Because until now
// HE was the detection system: the validator strips bad claims at generation, but nothing
// ever LOOKED at the finished reports afterwards, so anything the rules didn't yet know
// about sailed through in silence and waited to be spotted in a brief.
//
// This is the missing half. Every night, after regeneration, every stored read for every
// brand is re-checked against the real facts of its own captures, plus two cross-checks the
// per-read gate cannot make on its own:
//   • CONTRADICTION — a read claiming change on a day the computed diff found none.
//   • DIVERGENCE   — the app read and the Slack brief telling different stories.
// Anything found is posted to Slack. Silence means it genuinely passed.
export async function qualityAudit({ day, alert = false } = {}) {
  const { checkClaims } = await import('./claims.js');
  const { diffWebsite } = await import('./website.js');
  const today = day || new Date().toISOString().slice(0, 10);
  const brands = await allBrands();
  const capN = Number(process.env.ADS_COUNT) || 50;
  const findings = [];

  for (const b of brands) {
    let rows;
    try {
      rows = await pool.query(
        `SELECT channel, to_char(day,'YYYY-MM-DD') AS day, data FROM snapshots
          WHERE host = $1 AND day >= $2::date - 1 AND day <= $2::date`, [b.host, today]);
    } catch (e) { continue; }
    const at = (ch, d) => (rows.rows.find((r) => r.channel === ch && r.day === d) || {}).data || null;
    const yday = new Date(Date.parse(today) - 86400000).toISOString().slice(0, 10);
    const ins = at('insights', today) || at('insights', yday);
    if (!ins) continue;

    const a0 = (at('ads', today) || {}).ads || [], a1 = (at('ads', yday) || {}).ads || [];
    const w0 = at('website', today), w1 = at('website', yday);
    const wDiff = (w0 && w1 && w0.summary && w1.summary) ? (diffWebsite(w1.summary, w0.summary) || []) : null;
    const facts = {
      canJudgeAbsence: !!(a0.length && a0.length < Math.floor(capN * 0.95) && !(a1.length && a0.length < a1.length * 0.6)),
      hasEarlier: !!(at('ads', yday) || at('website', yday)),
      comparable: !!(w0 && w1),
      priceComparable: !!(w0 && w1 && w0.summary && w1.summary),
      canAssertNew: !!(at('ads', yday) || at('website', yday)),
      noChanges: Array.isArray(wDiff) && wDiff.length === 0,
    };

    const texts = [];
    for (const ch of ['ads', 'website', 'social', 'email']) {
      const sec = ins[ch]; if (!sec) continue;
      if (sec.summary) texts.push([ch, sec.summary]);
      // The bullets carry the specific claims and skipped this audit entirely until 7 Aug —
      // the audit read only the summaries, so a bad bullet could sit in a stored report for
      // days with the nightly pass reporting "no unsupported claims".
      (Array.isArray(sec.bullets) ? sec.bullets : []).forEach((t, i) => { if (t) texts.push([ch + '.bullet' + i, t]); });
      if (sec.apply) texts.push([ch + '.apply', sec.apply]);
    }
    for (const k of ['verdict', 'move']) {
      const arr = ins.brief && ins.brief[k];
      if (Array.isArray(arr)) arr.forEach((t, i) => texts.push(['brief.' + k + i, t]));
    }
    for (const [where, text] of texts) {
      // Advice lines (counter-op "move" + per-channel "apply") may talk price moves; the
      // website read and its bullets are the only ones judged against the diff invariant.
      const isAdvice = where.startsWith('brief.move') || where.endsWith('.apply');
      const f = isAdvice ? { ...facts, noChanges: false, advice: true }
        : (where === 'website' || where.startsWith('website.') ? facts : { ...facts, noChanges: false });
      for (const v of checkClaims(text, f)) {
        findings.push({ brand: b.name || b.host, where, rule: v.rule, sentence: v.sentence.slice(0, 160) });
      }
    }
  }

  const out = { day: today, brands: brands.length, findings };
  if (alert) {
    if (!findings.length) console.log('✓ quality audit: ' + brands.length + ' brands, no unsupported claims');
    else {
      const lines = findings.slice(0, 12).map((f) => '   • *' + f.brand + '* [' + f.where + '] (' + f.rule + ')\n      "' + f.sentence + '"');
      const msg = '🔎 *WatchBack quality audit — ' + today + '*\n' + findings.length +
        ' unsupported claim(s) found in stored reads across ' + brands.length + ' brands:\n' + lines.join('\n') +
        (findings.length > 12 ? '\n   …and ' + (findings.length - 12) + ' more' : '');
      console.warn(msg.replace(/\*/g, ''));
      try { const { postText } = await import('./slack.js'); await postText(msg); } catch (e) { /* best-effort */ }
    }
  }
  return out;
}

// ── DAILY COVERAGE AUDIT ──────────────────────────────────────────────────────
// "It's not acceptable if the website scan or screenshot fails and then you do nothing
// about it" (founder, 1 Aug). Reliability is the product: a silent capture gap becomes a
// silent wrong insight tomorrow. So every day we VERIFY what actually landed, repair what
// didn't, and if it still can't be captured we SAY SO instead of pretending.
export async function coverageAudit({ repair = true, day } = {}) {
  const today = day || new Date().toISOString().slice(0, 10);
  const brands = await allBrands();
  const rows = [];
  for (const b of brands) {
    let web = false, shot = false, ads = false;
    try {
      const r = await pool.query(
        `SELECT channel, data FROM snapshots WHERE host = $1 AND day = $2 AND channel IN ('website','ads')`,
        [b.host, today]);
      for (const x of r.rows) {
        if (x.channel === 'website') { web = true; shot = !!(x.data && (x.data.shot || x.data.shotFrom)); }
        if (x.channel === 'ads') ads = true;
      }
    } catch (e) { /* treat as missing */ }
    // A brand with NO social accounts connected is invisible on social forever, and until
    // now nothing said so — the brief just reported "no new posts" (Pannonian Padel, 5 Aug).
    let social = false;
    try {
      const r2 = await pool.query(
        `SELECT channel, data FROM snapshots WHERE host = $1 AND channel IN ('instagram','tiktok','facebook') ORDER BY day DESC LIMIT 6`, [b.host]);
      social = r2.rows.some((x) => x.data && Array.isArray(x.data.posts) && x.data.posts.length > 0);
    } catch (e) { /* treat as missing */ }
    rows.push({ host: b.host, name: b.name, web, shot, ads, social });
  }
  let repaired = 0;
  if (repair) {
    // Try to RESOLVE missing social accounts, not just report them: re-read the brand's site
    // for handles and persist them, so the gap can actually close (Pannonian Padel, 5 Aug).
    for (const r of rows.filter((x) => !x.social)) {
      try {
        const { resolveHandles } = await import('./social.js');
        const h = await resolveHandles(r.host);
        if (h && Object.keys(h).length) {
          await pool.query('UPDATE competitors SET handles = $2, updated_at = now() WHERE host = $1', [r.host, JSON.stringify(h)]);
          r.handlesFound = Object.keys(h).join(',');
        }
      } catch (e) { /* best-effort */ }
    }
    for (const r of rows.filter((x) => !x.web || !x.shot)) {
      const b = brands.find((x) => x.host === r.host);
      if (!b) continue;
      try {
        await warmBrand(b, true);   // force — the point is to fill a real gap
        const q = await pool.query(`SELECT data FROM snapshots WHERE host = $1 AND day = $2 AND channel = 'website'`, [r.host, today]);
        const d = q.rows[0] && q.rows[0].data;
        if (d) { r.web = true; r.shot = !!(d.shot || d.shotFrom); repaired++; }
      } catch (e) { r.error = e.message; }
    }
  }
  const missing = rows.filter((r) => !r.web || !r.shot);
  const noSocial = rows.filter((r) => !r.social);
  return { day: today, total: rows.length, ok: rows.length - missing.length, repaired, missing, noSocial, rows };
}

// Report the audit to the founder's Slack — silence is only acceptable when everything landed.
export async function coverageAuditAndAlert() {
  try {
    const a = await coverageAudit({ repair: true });
    const socialGap = (a.noSocial || []).length
      ? '\n\n📵 *No social accounts connected* — these brands can never show social activity, and their reports must say so rather than "no new posts":\n' +
        a.noSocial.slice(0, 10).map((m) => '   • ' + (m.name || m.host)).join('\n') +
        ((a.noSocial.length > 10) ? '\n   …and ' + (a.noSocial.length - 10) + ' more' : '')
      : '';
    if (!a.missing.length) {
      console.log('✓ coverage audit: all ' + a.total + ' brands captured' + (a.repaired ? ' (' + a.repaired + ' repaired)' : ''));
      if (socialGap) { try { const { postText } = await import('./slack.js'); await postText('🔎 *WatchBack coverage — ' + a.day + '*' + socialGap); } catch (e) { /* best-effort */ } }
      return a;
    }
    const lines = a.missing.map((m) => '   • ' + (m.name || m.host) + ' — ' + (!m.web ? 'no website capture' : 'no screenshot') + (m.error ? ' (' + String(m.error).slice(0, 80) + ')' : ''));
    const msg = '⚠️ *WatchBack capture gap — ' + a.day + '*\n' + a.missing.length + ' of ' + a.total +
      ' brand(s) could not be captured even after a retry' + (a.repaired ? ' (' + a.repaired + ' others were repaired)' : '') +
      '. Their reads will say the data is missing rather than guess:\n' + lines.join('\n') + socialGap;
    console.warn(msg.replace(/\*/g, ''));
    try { const { postText } = await import('./slack.js'); await postText(msg); } catch (e) { /* alert best-effort */ }
    return a;
  } catch (e) { console.warn('coverage audit failed:', e.message); return null; }
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
  // Audit 90 minutes after the nightly capture: verify, repair, and alert on what's left.
  function armAudit() {
    const ms = msUntil((warmHour + 1) % 24, tz) + 30 * 60000;
    setTimeout(() => {
      coverageAuditAndAlert()
        .catch(() => {})
        // Quality follows coverage: check WHAT was written, not just THAT it was captured.
        .then(() => qualityAudit({ alert: true }).catch(() => {}));
      armAudit();
    }, ms);
  }
  armWarm();
  armBrief();
  armAudit();

  // Warm shortly after boot so a fresh deploy is never cold (capture only — never sends a brief).
  setTimeout(() => refreshAll(false).catch(() => {}), 15000);
}
