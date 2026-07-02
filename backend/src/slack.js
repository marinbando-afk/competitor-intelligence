// ── Daily competitor brief to Slack ───────────────────────────────────────────
// A once-a-day digest: one sentence per channel (ads / social / website / email)
// for each watched brand, posted to a Slack channel via an Incoming Webhook.
// Set in Railway:  SLACK_WEBHOOK_URL = https://hooks.slack.com/services/T.../B.../xxxx
import { getInsights } from './insights.js';

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
