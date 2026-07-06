// ── Daily competitor brief to Slack ───────────────────────────────────────────
// A once-a-day digest: one sentence per channel (ads / social / website / email)
// for each watched brand, posted to a Slack channel via an Incoming Webhook.
// Set in Railway:  SLACK_WEBHOOK_URL = https://hooks.slack.com/services/T.../B.../xxxx
import Anthropic from '@anthropic-ai/sdk';
import { getInsights } from './insights.js';

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

// ── The SUPER-SHORT daily brief ───────────────────────────────────────────────
// One line per brand, ONLY material news that is new today; brands with nothing
// material are omitted, and a genuinely quiet day says so explicitly.
export async function buildDailyBrief(brands) {
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  const head = '🛰️ *WatchBack daily* · ' + today;
  const parts = [];
  for (const b of (brands || [])) {
    try {
      const ins = await getInsights(b.host, b.name);
      if (!ins) continue;
      const ch = [];
      for (const k of ['ads', 'social', 'website', 'email']) {
        const c = ins[k];
        if (c && (c.summary || (c.bullets || []).length)) ch.push(k.toUpperCase() + ': ' + (c.summary || '') + ((c.bullets || []).length ? ' — ' + c.bullets.join(' · ') : ''));
      }
      if (ch.length) parts.push('BRAND "' + b.name + '":\n' + ch.join('\n'));
    } catch (e) { /* skip brand */ }
  }
  if (!parts.length) return head + '\nAll quiet — nothing captured for your watched competitors today.';
  if (!process.env.ANTHROPIC_API_KEY) return head + '\nDaily check complete — open the app for today’s dossiers.';
  const system =
    'You write WatchBack\'s DAILY Slack brief for a busy eCommerce founder. SUPER SHORT is the whole point. ' +
    'From the per-brand channel reads below, call out ONLY what is MATERIAL and NEW TODAY: a sale starting, ending or changing; real price moves; a burst of new ads or a new funnel/landing type; new products; email campaigns sent. ' +
    'Ongoing unchanged states (a sale still running, the same ad set continuing) and tiny fluctuations (an ad or two, a single post) are NOT daily news — omit them. ' +
    'Output Slack mrkdwn only, no header: at most ONE line per brand, exactly "• *Brand* — <the material thing(s), <=18 words>". OMIT brands with nothing material. ' +
    'If NOTHING material happened for any brand, output EXACTLY this single line: "All quiet — no material competitor moves today." Never invent; use only the reads.';
  try {
    const resp = await briefClient().messages.create({ model: BRIEF_MODEL, max_tokens: 300, system, messages: [{ role: 'user', content: parts.join('\n\n') }] });
    const txt = (resp.content || []).filter((x) => x.type === 'text').map((x) => x.text).join('').trim();
    return head + '\n' + (txt || 'All quiet — no material competitor moves today.');
  } catch (e) {
    return head + '\nDaily check complete — open the app for today’s dossiers.';
  }
}

export async function postDailyBrief(brands) {
  if (!slackEnabled()) return { sent: false, reason: 'SLACK_WEBHOOK_URL not set' };
  const text = await buildDailyBrief(brands);
  return postText(text);
}

// Plain mrkdwn post to the founder webhook (used for weekly-report links etc.).
export async function postText(text) {
  if (!slackEnabled()) return { sent: false, reason: 'SLACK_WEBHOOK_URL not set' };
  try {
    const r = await fetch(process.env.SLACK_WEBHOOK_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, mrkdwn: true }),
    });
    return { sent: r.ok };
  } catch (e) { return { sent: false, error: e.message }; }
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
