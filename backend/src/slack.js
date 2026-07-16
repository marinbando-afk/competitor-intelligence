// ── Daily competitor brief to Slack ───────────────────────────────────────────
// A once-a-day digest: one sentence per channel (ads / social / website / email)
// for each watched brand, posted to a Slack channel via an Incoming Webhook.
// Set in Railway:  SLACK_WEBHOOK_URL = https://hooks.slack.com/services/T.../B.../xxxx
import Anthropic from '@anthropic-ai/sdk';
import { getInsights } from './insights.js';
import { dailySignals, signalLines } from './signals.js';

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
export async function buildDailyBrief(brands, viewUrl) {
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  const head = '🛰️ *WatchBack daily* · ' + today;
  if (!(brands || []).length) return head + '\nNo competitors on the watchlist yet.';
  const link = viewUrl || 'https://watchback.ai/app.html';
  const lines = [];
  for (const b of brands) {
    let sig = [];
    try { sig = signalLines(await dailySignals(b.host)); } catch (e) { /* treat as quiet */ }
    if (sig.length) { lines.push('*' + b.name + '* 💡'); sig.forEach((l) => lines.push('   ' + l)); }
    else lines.push('*' + b.name + '* — all quiet ✅');
  }
  return head + '\n\n' + lines.join('\n') + '\n\n🔗 <' + link + '|View the full dashboard & signals →>';
}

export async function postDailyBrief(brands, viewUrl) {
  if (!slackEnabled()) return { sent: false, reason: 'SLACK_WEBHOOK_URL not set' };
  const text = await buildDailyBrief(brands, viewUrl);
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
  if (!pool) return;
  let sent = 0;
  try {
    const us = await pool.query(`SELECT id, slack_webhook, share_token FROM users WHERE slack_webhook IS NOT NULL AND slack_webhook <> ''`);
    for (const u of us.rows) {
      try {
        const cs = await pool.query('SELECT name, host FROM competitors WHERE user_id = $1 ORDER BY created_at ASC', [u.id]);
        if (!cs.rows.length) continue;
        // Teammate view link = this account's OWN read-only share link (opens without a login).
        const viewUrl = u.share_token ? ('https://watchback.ai/app.html?share=' + encodeURIComponent(u.share_token)) : 'https://watchback.ai/app.html';
        const text = await buildDailyBrief(cs.rows, viewUrl);
        const r = await postTo(u.slack_webhook, text);
        if (r.sent) sent++;
      } catch (e) { /* skip this user */ }
    }
  } catch (e) { console.warn('sendUserDailyBriefs:', e.message); }
  if (sent) console.log('✓ per-user Slack daily briefs sent: ' + sent);
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
