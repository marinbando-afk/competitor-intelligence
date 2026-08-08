// ── Daily competitor brief to Slack ───────────────────────────────────────────
// A once-a-day digest: one sentence per channel (ads / social / website / email)
// for each watched brand, posted to a Slack channel via an Incoming Webhook.
// Set in Railway:  SLACK_WEBHOOK_URL = https://hooks.slack.com/services/T.../B.../xxxx
import Anthropic from '@anthropic-ai/sdk';
import { randomBytes } from 'crypto';
import { getInsights } from './insights.js';
import { dailySignals, signalLines, activityLines } from './signals.js';
import { latestSnapshot } from './snapshots.js';
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
    // THE SYNC RULE (founder, 21 Jul): the Slack brief is a RECAP of the platform's own
    // report — it must tell the same story the dashboard shows. So every brand's block
    // leads with the top line of the SAME shared insights snapshot the app displays
    // (cache-only read: latestSnapshot, never getInsights — no AI call, no self-heal,
    // byte-identical to what the user sees in the app). The deterministic signal lines
    // then list what CHANGED. Skipped only when the stored read is stale (>2 days) —
    // better no quote than quoting old news as today's.
    let read = '', adsRow = '';
    try {
      const ins = await latestSnapshot(b.host, 'insights');
      const v = ins && ins.brief && Array.isArray(ins.brief.verdict) && ins.brief.verdict[0];
      const fresh = ins && ins.__day && (Date.parse(todayISO) - Date.parse(ins.__day)) <= 2 * 864e5;
      if (v && fresh) read = '   _' + String(v).replace(/[\n_]+/g, ' ').trim() + '_';
      if (fresh) { const al = adsRecapLine(ins); if (al) adsRow = '   📣 Ads: ' + al; }
    } catch (e) { /* signals still carry the block */ }
    // Three tiers, so "quiet" never hides real activity:
    //   💡 a PRIORITY move (sale/funnel/FB page/products/angle/fake-sale) — the big callout
    //   🔹 ROUTINE activity — they shipped a new ad/email/post but nothing rose to priority
    //   ✅ genuinely nothing new captured (the current read still shown, so Slack and the
    //      dashboard agree even on a quiet day)
    const sig = signalLines(s);
    // A SALE-state signal is TODAY's news; the quoted read regenerates only nightly, so on
    // sale-change mornings it can flatly contradict the bullet beneath it ("No active sale"
    // above "• Sale live: …", 22 Jul). The fresher fact wins — drop the stale read line.
    if (read && s && s.sale) read = '';
    // BULLETED layout (founder, 22 Jul): the italic read is the brand's summary line;
    // every change line below it is a bullet — scannable instead of a wall of text.
    // Don't say the same thing twice (founder, 1 Aug): the italic read already summarised
    // the day, so a bullet whose distinctive words are all present in it adds nothing but
    // noise — and usually a worse, truncated version of the same fact.
    const distinctive = (t) => (String(t).toLowerCase().match(/[a-z0-9][a-z0-9'’-]{4,}/g) || [])
      .filter((w) => !['their','there','these','those','still','since','after','before','which','while','running','launched','products','product','website','storefront'].includes(w));
    const readWords = new Set(distinctive(read || ''));
    const notInRead = (l) => {
      if (!readWords.size) return true;
      const w = distinctive(l);
      if (w.length < 2) return true;
      const hit = w.filter((x) => readWords.has(x)).length;
      return hit / w.length < 0.6;   // most of this line is already in the read → drop it
    };
    const bullets = (ls) => ls.map((l) => '   • ' + l).join('\n');
    // The ads row obeys the same no-repeat rule: if the italic read already carries the ad
    // message, don't say it twice — otherwise it appears in EVERY tier, including quiet days
    // (the client reads the brief precisely to learn what competitors' ads are saying).
    if (adsRow && !notInRead(adsRow)) adsRow = '';
    const sigK = sig.filter(notInRead);
    if (sigK.length) {
      blocks.push('*' + b.name + '* 💡\n' + (read ? read + '\n' : '') + (adsRow ? adsRow + '\n' : '') + bullets(sigK));
    } else if (sig.length && read) {
      blocks.push('*' + b.name + '* 💡\n' + read + (adsRow ? '\n' + adsRow : ''));   // the read already says it all
    } else {
      const act = activityLines(s).filter(notInRead);
      if (act.length) blocks.push('*' + b.name + '* 🔹 routine activity\n' + (read ? read + '\n' : '') + (adsRow ? adsRow + '\n' : '') + bullets(act));
      else blocks.push('*' + b.name + '* ✅ no new moves' + (read ? '\n' + read : '') + (adsRow ? '\n' + adsRow : ''));
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
