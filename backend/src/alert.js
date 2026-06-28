// Outbound email alerts to the founder (e.g. "AI credits are empty").
// Uses Resend (free tier, no domain setup needed to email your own address).
// Set in Railway:
//   RESEND_API_KEY  your Resend API key (re_...)
//   ALERT_EMAIL     where alerts go (use the email you signed up to Resend with)
//   ALERT_FROM      (optional) sender; defaults to Resend's no-setup test sender
const FROM = process.env.ALERT_FROM || 'IntelAI Alerts <onboarding@resend.dev>';

export async function sendEmail(subject, html) {
  if (!process.env.RESEND_API_KEY || !process.env.ALERT_EMAIL) return false; // not configured yet — no-op
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: [process.env.ALERT_EMAIL], subject, html }),
    });
    if (!r.ok) { console.warn('alert email failed ' + r.status + ': ' + (await r.text().catch(() => '')).slice(0, 140)); return false; }
    return true;
  } catch (e) { console.warn('alert email error: ' + e.message); return false; }
}

let lastCreditAlert = 0;
const GAP = 20 * 60 * 60 * 1000; // at most ~one credit alert per day, however many calls fail

// Fired when a Claude call reports an empty balance. Throttled so a burst of
// failures (or repeated boots) sends ONE email, not dozens.
export async function notifyCreditsEmpty() {
  if (Date.now() - lastCreditAlert < GAP) return false;
  lastCreditAlert = Date.now(); // claim the slot before awaiting so concurrent failures don't double-send
  const ok = await sendEmail(
    'IntelAI: your Claude AI credits are empty',
    '<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.55;color:#111">' +
    '<p style="font-size:17px"><b>Your Anthropic AI credits have run out.</b></p>' +
    '<p>Until you top up, the AI features are paused — competitor insights, ad angle/hook analysis and video-script reads will show blank. (Already-saved results still display.)</p>' +
    '<div style="margin:18px 0;padding:14px 16px;background:#f4f6f8;border-radius:8px">' +
    '<b>Fix it (~2 min):</b><br>1. Open <a href="https://console.anthropic.com">console.anthropic.com</a><br>' +
    '2. Left sidebar → <b>Billing</b><br>3. <b>Buy credits</b> (≈$20 is plenty)<br>' +
    '4. Turn on <b>Auto-reload</b> so it never empties again</div>' +
    '<p>Everything resumes on its own once the balance is positive — nothing to redeploy.</p>' +
    '<p style="color:#888;font-size:13px">— IntelAI watchdog</p></div>'
  );
  if (!ok) lastCreditAlert = 0; // send didn't go through → allow a retry next time
  return ok;
}
