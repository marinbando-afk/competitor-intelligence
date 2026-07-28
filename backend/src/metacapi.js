// Meta Conversions API — server-side Purchase events, fed by the Stripe webhook.
// The browser pixel loses 10-30% of conversions to ad-blockers/iOS/closed tabs; this
// sends the same event server-to-server on the ground truth (money moved), deduplicated
// against the pixel by a shared event id (the Stripe checkout-session id).
//
// DORMANT WITHOUT THE TOKEN: set META_CAPI_TOKEN in Railway (Events Manager → dataset
// Settings → Conversions API → Generate access token). Optional META_CAPI_TEST_CODE
// routes events to the Test Events tab instead of live data (leave unset in production).

import crypto from 'crypto';

const PIXEL_ID = '28423431670573533';
const TOKEN = () => process.env.META_CAPI_TOKEN || '';
const sha256 = (s) => crypto.createHash('sha256').update(String(s).trim().toLowerCase()).digest('hex');

export function capiEnabled() { return !!TOKEN(); }

// Fire-and-forget: a Meta hiccup must never affect billing. Returns Meta's reply for logs.
export async function capiEvent({ name, value, currency, email, eventId, sourceUrl }) {
  if (!capiEnabled()) return null;
  try {
    const ev = {
      event_name: name,
      event_time: Math.floor(Date.now() / 1000),
      action_source: 'website',
      event_source_url: sourceUrl || 'https://watchback.ai/app.html',
      event_id: eventId || undefined,
      user_data: email ? { em: [sha256(email)] } : {},
      custom_data: value != null ? { value: Number(value), currency: currency || 'USD' } : undefined,
    };
    const body = { data: [ev] };
    if (process.env.META_CAPI_TEST_CODE) body.test_event_code = process.env.META_CAPI_TEST_CODE;
    const r = await fetch('https://graph.facebook.com/v21.0/' + PIXEL_ID + '/events?access_token=' + encodeURIComponent(TOKEN()), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) console.warn('CAPI ' + name + ':', JSON.stringify(j).slice(0, 200));
    else console.log('✓ CAPI ' + name + ' sent (' + (value != null ? '$' + value : 'no value') + ')');
    return j;
  } catch (e) { console.warn('CAPI ' + name + ':', e.message); return null; }
}

// Token sanity check for the /api/capi-status diagnostic — never exposes the token itself.
export async function capiTokenValid() {
  if (!capiEnabled()) return false;
  try {
    const r = await fetch('https://graph.facebook.com/v21.0/me?access_token=' + encodeURIComponent(TOKEN()), { signal: AbortSignal.timeout(10000) });
    return r.ok;
  } catch (e) { return false; }
}
