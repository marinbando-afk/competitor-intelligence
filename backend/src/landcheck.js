// landcheck.js — test where each ad's landing URL ACTUALLY goes, at capture time.
//
// Ads keep paying for clicks after a funnel dies or gets retired, and neither shows up
// in the Ad Library data itself. Founder, 9 Aug: "get.thetallowedtruth.com is giving me
// 404 — you must catch this" and "it would be even more useful if you tested the URL and
// caught they are redirecting it from try-derm to their regular homepage". So: one
// representative URL per distinct landing domain, fetched with redirects followed, final
// URL + HTTP status stored on the ads snapshot. findings.js turns the stored results into
// deterministic ads.landDown / ads.landRedirect findings — no model judgment involved.

const domOf = (u) => String(u || '').replace(/^https?:\/\//, '').split('/')[0].split('?')[0].replace(/^www\./, '').toLowerCase();
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Skip hosts that are not the advertiser's own funnel: platform/marketplace links resolve
// through consent walls and bot checks and would only produce false alarms.
const SKIP = /(^|\.)(facebook|instagram|fb|amazon|walmart|target|tiktok|youtube|apple|google)\.(com|me|co\.[a-z]+)$/i;

export async function resolveLandings(ads, cap = 6) {
  const byDom = new Map();
  for (const a of ads || []) {
    const raw = a && a.landing;
    const d = domOf(raw);
    if (!d || SKIP.test(d) || byDom.has(d)) continue;
    byDom.set(d, /^https?:\/\//i.test(String(raw)) ? String(raw) : 'https://' + String(raw));
    if (byDom.size >= cap) break;
  }
  if (!byDom.size) return null;
  const out = {};
  await Promise.all([...byDom].map(async ([d, url]) => {
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(12000), headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' } });
      out[d] = { url, finalUrl: res.url || url, status: res.status };
      try { if (res.body && res.body.cancel) await res.body.cancel(); } catch (e) { /* stream cleanup only */ }
    } catch (e) {
      // A network failure (timeout, DNS, TLS) is NOT a dead page — record it as unknown
      // so findings.js stays silent rather than crying 404 on a transient error.
      out[d] = { url, error: String((e && e.message) || e).slice(0, 80) };
    }
  }));
  return out;
}
