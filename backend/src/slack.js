// ── Daily competitor brief to Slack ───────────────────────────────────────────
// A once-a-day digest: one sentence per channel (ads / social / website / email)
// for each watched brand, posted to a Slack channel via an Incoming Webhook.
// Set in Railway:  SLACK_WEBHOOK_URL = https://hooks.slack.com/services/T.../B.../xxxx
import Anthropic from '@anthropic-ai/sdk';
import { randomBytes } from 'crypto';
import { getInsights } from './insights.js';
import { dailySignals, signalLines, activityLines } from './signals.js';
import { latestSnapshot } from './snapshots.js';
import { stripUrlParams, stripAdTotals } from './adsguard.js';
import { pool } from './db.js';

// The founder roll-up brief's "view" link must be a REAL read-only share link (opens
// without a login), not the bare app URL. Resolve the founder/admin account's share
// token, minting one if it has none.
async function founderShareUrl() {
  try {
    if (!process.env.DATABASE_URL) return 'https://watchback.ai/app.html';
    const r = await pool.query('SELECT id, share_token FROM users WHERE admin = TRUE ORDER BY id ASC LIMIT 1');
    if (!r.rows[0]) return 'https://watchback.ai/app.html';
    let tok = r.rows[0].share_token;
    if (!tok) { tok = randomBytes(9).toString('base64url'); await pool.query('UPDATE users SET share_token = $2 WHERE id = $1', [r.rows[0].id, tok]); }
    return 'https://watchback.ai/app.html?share=' + encodeURIComponent(tok);
  } catch (e) { return 'https://watchback.ai/app.html'; }
}

const BRIEF_MODEL = process.env.INSIGHTS_MODEL || 'claude-sonnet-4-6';
let _bc;
function briefClient() { if (!_bc) _bc = new Anthropic(); return _bc; }

const ICON = { ads: '📣', social: '📱', website: '🌐', email: '✉️' };
const LBL = { ads: 'Ads', social: 'Social', website: 'Website', email: 'Email' };

export function slackEnabled() { return !!process.env.SLACK_WEBHOOK_URL; }

// Build the Slack message (mrkdwn): a header, then one line per channel per brand.
export async function buildDigest(brands) {
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  const out = ['*🛰️ WatchBack — Daily competitor brief* · ' + today];
  for (const b of (brands || [])) {
    let ins = null;
    try { ins = await getInsights(b.host, b.name); } catch (e) { /* skip this brand */ }
    out.push('\n*' + b.name + '*');
    let any = false;
    for (const ch of ['ads', 'social', 'website', 'email']) {
      const s = ins && ins[ch] && ins[ch].summary;
      if (s) { out.push(ICON[ch] + ' *' + LBL[ch] + ':* ' + s); any = true; }
    }
    if (!any) out.push('_No fresh read yet — check back after the next daily capture._');
  }
  return out.join('\n');
}

// ── The daily brief ───────────────────────────────────────────────────────────
// Structured, deterministic and PRIORITY-ORDERED — every brand is accounted for,
// and the moves that matter most lead: sale change → new funnel → new FB page →
// new products → new ad angle (unused ≥2 weeks). See signals.js for detection.
// Layout: header, a blank row, then one line per brand — 💡 marks a brand with
// moves (its signals listed beneath), ✅ marks an all-quiet brand — then a blank
// row and a read-only view link teammates can open without an account.
// ADS RECAP ROW (client feedback via founder, 8 Aug: "these daily updates could be next
// level if they said the core message in the ads"). Every brand block now carries ONE ads
// line — the core message/angles their ads are running — quoted from the same stored
// insights snapshot the app shows (SYNC RULE: the brief recaps the platform's report, it
// never re-derives). On launch days the stored summary leads with the launches; on quiet
// days it states the standing core message — either way the client learns what the
// competitor's ads are SAYING, every single morning. Exported for test/slack.test.js.
export function adsRecapLine(ins) {
  const a = ins && ins.ads;
  if (!a || !a.summary) return '';
  const clean = (x) => String(x || '').replace(/[\n_]+/g, ' ').replace(/\s+/g, ' ').trim();
  let t = clean(a.summary);
  const b1 = clean(Array.isArray(a.bullets) && a.bullets[0]);
  if (b1 && (t.length + b1.length) <= 300) t += (/[.!?]$/.test(t) ? ' ' : ' — ') + b1;
  return t;
}

// ——— delivery-time cleanup (founder, 10 Aug: the brief "became a mess") ————————————
// The brief is read the morning AFTER the capture it quotes ("just say 'yesterday'
// because that's what the report is about" — global rule for every future update).
// Generators keep writing "today" on capture day; the SENDER re-anchors day language to
// the reader's clock. Only the capture day itself is relativized — real news dates from
// before it (a Meta launch date, a sale start) stay as dates. Exported for tests.
export function relativizeDay(s, capDay, sendDay) {
  s = String(s || '');
  if (!s || !capDay || !sendDay || capDay === sendDay) return s;
  const prev = new Date(Date.parse(sendDay + 'T00:00:00Z') - 864e5).toISOString().slice(0, 10);
  const word = capDay === prev ? 'yesterday' : 'on ' + capDay;
  const poss = capDay === prev ? 'yesterday’s' : 'that day’s';
  return s
    .replace(/\btoday\s*\(\s*\d{4}-\d{2}-\d{2}\s*\)/gi, word)     // "today (2026-08-09)"
    .replace(new RegExp('\\s*\\(\\s*' + capDay + '\\s*\\)', 'g'), '')  // bare "(2026-08-09)" = clutter
    .replace(new RegExp('\\bon\\s+' + capDay + '\\b', 'g'), word)
    .replace(new RegExp('\\b' + capDay + '\\b', 'g'), word)
    .replace(/\btoday['’]s\b/gi, poss)
    .replace(/\btoday\b/gi, word)
    .replace(/\b(yesterday)(\s+yesterday)+\b/gi, '$1')
    .replace(/ {2,}/g, ' ');
}

// Clip at a SENTENCE boundary — a mid-quote chop ("...spec-led hooks (':rotating_light:
// BEST SELLER…") reads as a glitch — and close anything the model's own clipping left open.
function clipSent(t, n) {
  t = String(t || '').trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  const b = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (b > n * 0.4) return cut.slice(0, b + 1);
  // Next best: a clause boundary. Cutting mid-clause left dangling labels in the brief
  // ("…; newest opens." with the quote gone — founder, 12 Aug); dropping the whole
  // unfinished clause keeps every surviving clause complete.
  const c = Math.max(cut.lastIndexOf('; '), cut.lastIndexOf(' — '));
  if (c > n * 0.4) return cut.slice(0, c).replace(/[\s.,;:—–-]+$/, '') + '.';
  const sp = cut.lastIndexOf(' ');
  return (sp > 0 ? cut.slice(0, sp) : cut).replace(/[\s.,;:—–-]+$/, '') + '…';
}
function balanceQuotes(t) {
  t = String(t || '').trim();
  while ((t.match(/\(/g) || []).length > (t.match(/\)/g) || []).length && t.includes('(')) {
    t = t.slice(0, t.lastIndexOf('(')).replace(/[\s—–\-:,;]+$/, '');
  }
  if (((t.match(/"/g) || []).length % 2) === 1) {
    const i = t.lastIndexOf('"');
    if (i > t.length * 0.4) t = t.slice(0, i).replace(/[\s—–\-:,;]+$/, '');
  }
  if ((t.match(/“/g) || []).length > (t.match(/”/g) || []).length && t.includes('“')) {
    t = t.slice(0, t.lastIndexOf('“')).replace(/[\s—–\-:,;]+$/, '');
  }
  if (t && !/[.!?…]$/.test(t)) t += '.';
  return t;
}
const sentSplit = (t) => String(t || '').trim().split(/(?<=[.!?])\s+/).filter(Boolean);

export async function buildDailyBrief(brands, viewUrl, commit) {
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  const head = '🛰️ *WatchBack daily* · ' + today;
  if (!(brands || []).length) return head + '\nNo competitors on the watchlist yet.';
  const link = viewUrl || await founderShareUrl();
  const todayISO = new Date().toISOString().slice(0, 10);
  const blocks = [];
  let demoHeaderWritten = false;
  for (const b of brands) {
    if (b.__demo && !demoHeaderWritten) { blocks.push('— — —\n_Example brands we watch daily — not your competitors, and they don\u2019t use your slots._'); demoHeaderWritten = true; }
    let s = null;
    try { s = await dailySignals(b.host, !!commit); } catch (e) { /* treat as quiet */ }
    // INTERCEPTED-SIGNALS LAYOUT (founder, 10 Aug: "just use the app intercepted signals
    // in the slack message, and put an exclamation mark or something if it's a new signal
    // — I actually like this"). Each brand block mirrors the dashboard's per-channel
    // summary lines — the SYNC RULE made literal, so the brief can never contradict the
    // app (Babe Original, 10 Aug: app said "no changes today" while the brief re-announced
    // an 8-Aug price rise). One line per channel, ❗ when that channel carries a NEW
    // signal today. No verdict quote — a clipped verdict shipped context-free nonsense
    // ("It didn't matter how expensive.", Seranova, 10 Aug).
    let ins = null, capDay = '';
    try { ins = await latestSnapshot(b.host, 'insights'); } catch (e) { /* fall back to signal bullets */ }
    const fresh = !!(ins && ins.__day && (Date.parse(todayISO) - Date.parse(ins.__day)) <= 2 * 864e5);
    if (ins && ins.__day) capDay = String(ins.__day).slice(0, 10);
    // Re-anchor day language to the reader's clock (founder, 10 Aug — global rule: the
    // brief is read the morning after the capture, so "today" must become "yesterday").
    const prevISO = new Date(Date.parse(todayISO + 'T00:00:00Z') - 864e5).toISOString().slice(0, 10);
    const rel = (t) => relativizeDay(t, capDay || prevISO, todayISO);
    // stripUrlParams as a delivery-time backstop too: stored reads written before the
    // scrubber shipped (or any future surface that slips one through) still carry UTMs.
    const line = (t) => balanceQuotes(clipSent(rel(stripAdTotals(stripUrlParams(String(t || '').replace(/[\n_]+/g, ' ').replace(/\s+/g, ' ').trim()))), 240));
    const A = (s && s.activity) || {};
    const n = (x) => (Array.isArray(x) ? x.length : 0);
    const mark = (isNew) => (isNew ? '❗' : '');
    const ch = (k) => (fresh && ins[k] && ins[k].summary) ? String(ins[k].summary) : '';
    const social = ch('instagram') || ch('tiktok') || ch('facebook') || ch('social');
    const adsNew = !!(n(A.ads) || (s && (n(s.staleOffer) || n(s.funnel) || n(s.fbPage) || n(s.angle))));
    const webNew = !!((s && s.sale) || (s && n(s.products)) || n(A.website));
    const rows = [];
    if (ch('ads')) rows.push('   ' + mark(adsNew) + '📣 Ads: ' + line(adsRecapLine(ins)));
    if (social) rows.push('   ' + mark(!!n(A.posts)) + '📱 Social: ' + line(social));
    if (ch('website')) rows.push('   ' + mark(webNew) + '🛒 Website: ' + line(ins.website.summary));
    if (ch('email')) rows.push('   ' + mark(!!n(A.emails)) + '✉️ Email: ' + line(ins.email.summary));
    const pri = !!(s && (s.sale || n(s.staleOffer) || n(s.funnel) || n(s.fbPage) || n(s.products) || n(s.angle)));
    const anyAct = !!(n(A.ads) || n(A.posts) || n(A.emails) || n(A.website));
    const badge = pri ? '💡' : anyAct ? '🔹 routine activity' : '✅ no new moves';
    if (rows.length) {
      blocks.push('*' + b.name + '* ' + badge + '\n' + rows.join('\n'));
    } else {
      // No fresh stored read (rebuild missed the brand) — the deterministic signal lines
      // still carry the block, old-style bullets, so news is never dropped.
      const ls = (signalLines(s).length ? signalLines(s) : activityLines(s)).map(rel);
      blocks.push('*' + b.name + '* ' + badge + (ls.length ? '\n' + ls.map((l) => '   • ' + l).join('\n') : ''));
    }
  }
  return head + '\n\n' + blocks.join('\n\n') + '\n\n🔗 <' + link + '|View the full dashboard & signals →>';
}

export async function postDailyBrief(brands, viewUrl) {
  if (!slackEnabled()) return { sent: false, reason: 'SLACK_WEBHOOK_URL not set' };
  const text = await buildDailyBrief(brands, viewUrl, true);   // real delivery → commit announce-once state
  return postText(text);
}

// Plain mrkdwn post to the founder webhook (used for weekly-report links etc.).
export async function postText(text) {
  if (!slackEnabled()) return { sent: false, reason: 'SLACK_WEBHOOK_URL not set' };
  return postTo(process.env.SLACK_WEBHOOK_URL, text);
}

// Post to ANY Slack Incoming Webhook (per-user briefs). Validates the URL shape so a
// pasted junk string can't hit an arbitrary host.
export function isSlackWebhook(url) { return /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+$/.test(String(url || '')); }
export async function postTo(webhook, text) {
  if (!isSlackWebhook(webhook)) return { sent: false, error: 'Invalid Slack webhook URL.' };
  try {
    const r = await fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, mrkdwn: true }) });
    return { sent: r.ok, status: r.status };
  } catch (e) { return { sent: false, error: e.message }; }
}

// Per-account daily briefs: every user who connected Slack gets THEIR OWN competitors'
// brief in THEIR channel. (The env webhook, if set, still gets the founder's roll-up.)
export async function sendUserDailyBriefs(pool) {
  if (!pool) return { sent: 0, total: 0 };
  let sent = 0, total = 0;
  try {
    const us = await pool.query(`SELECT id, slack_webhook, share_token, demo_brands FROM users WHERE slack_webhook IS NOT NULL AND slack_webhook <> ''`);
    for (const u of us.rows) {
      try {
        const cs = await pool.query('SELECT name, host FROM competitors WHERE user_id = $1 ORDER BY created_at ASC', [u.id]);
        if (!cs.rows.length) continue;
        // Opt-in example brands (founder, 6 Aug): appended, never mixed into the client's own
        // list, and labelled in the brief so nobody reads a demo as their own competitor.
        let demoRows = [];
        if (u.demo_brands) { try { const { TRACKED } = await import('./refresh.js'); demoRows = TRACKED.map((t) => ({ name: t.name, host: t.host, __demo: true })); } catch (e) { /* optional */ } }
        total++;
        // Teammate view link = this account's OWN read-only share link (opens without a login).
        const viewUrl = u.share_token ? ('https://watchback.ai/app.html?share=' + encodeURIComponent(u.share_token)) : 'https://watchback.ai/app.html';
        const text = await buildDailyBrief(cs.rows.concat(demoRows), viewUrl, true);   // real delivery → commit announce-once state
        const r = await postTo(u.slack_webhook, text);
        if (r.sent) sent++;
      } catch (e) { /* skip this user */ }
    }
  } catch (e) { console.warn('sendUserDailyBriefs:', e.message); }
  if (sent) console.log('✓ per-user Slack daily briefs sent: ' + sent);
  return { sent, total };
}

// Monday: each user with Slack gets links to THEIR competitors' weekly reports.
export async function sendUserWeeklyLinks(pool, weekLabel) {
  if (!pool) return;
  try {
    const us = await pool.query(`SELECT id, slack_webhook FROM users WHERE slack_webhook IS NOT NULL AND slack_webhook <> ''`);
    for (const u of us.rows) {
      try {
        const cs = await pool.query('SELECT name, host FROM competitors WHERE user_id = $1 ORDER BY created_at ASC', [u.id]);
        if (!cs.rows.length) continue;
        // Opt-in example brands (founder, 6 Aug): appended, never mixed into the client's own
        // list, and labelled in the brief so nobody reads a demo as their own competitor.
        let demoRows = [];
        if (u.demo_brands) { try { const { TRACKED } = await import('./refresh.js'); demoRows = TRACKED.map((t) => ({ name: t.name, host: t.host, __demo: true })); } catch (e) { /* optional */ } }
        const text = '📊 *Weekly competitor reports are ready* (' + weekLabel + '):\n' +
          cs.rows.map((c) => '• ' + c.name + ' — https://watchback.ai/report.html?host=' + c.host).join('\n');
        await postTo(u.slack_webhook, text);
      } catch (e) { /* skip this user */ }
    }
  } catch (e) { console.warn('sendUserWeeklyLinks:', e.message); }
}

export async function postDigest(brands) {
  if (!slackEnabled()) return { sent: false, reason: 'SLACK_WEBHOOK_URL not set' };
  const text = await buildDigest(brands);
  try {
    const r = await fetch(process.env.SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, mrkdwn: true }),
    });
    if (!r.ok) { const t = await r.text().catch(() => ''); console.warn('slack post failed ' + r.status + ': ' + t.slice(0, 120)); return { sent: false, status: r.status }; }
    return { sent: true, brands: (brands || []).length };
  } catch (e) { console.warn('slack post error: ' + e.message); return { sent: false, error: e.message }; }
}
