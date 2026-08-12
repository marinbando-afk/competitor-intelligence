// Delivery gate + self-audit regression tests. Every rule here traces to a founder
// correction — if one of these goes red, a shipped fix has silently un-fixed itself.
import { checkText, gateLine } from '../src/rulecheck.js';
import { checkMisses } from '../src/qa.js';
import { repairPreview } from '../src/email.js';
import { adsFindings } from '../src/findings.js';

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}
const fires = (t, id, surface) => checkText(t, { surface: surface || 'slack' }).some((v) => v.id === id);
const clean = (t, surface) => checkText(t, { surface: surface || 'slack' }).length === 0;

console.log('\nDELIVERY GATE — rules fire on violations:');
ok(fires('New funnel: https://x.com/lp?utm_source=fb&utm_campaign=q3', 'R-URL-01'), 'R-URL-01 UTM query string');
ok(fires('79 active — same creatives still running', 'R-ADS-01'), 'R-ADS-01 active-ad total');
ok(fires('all 98 ads in today’s capture push merch', 'R-ADS-01'), 'R-ADS-01 capture volume');
ok(fires('The offer has been live since 2026-07-15.', 'R-DATE-02'), 'R-DATE-02 live-since dating');
ok(fires('subject =E2=80=8C=C2=A0 preheader junk', 'R-TEXT-01'), 'R-TEXT-01 undecoded QP');
ok(fires('24 new ads launched; newest opens.', 'R-TEXT-02'), 'R-TEXT-02 dangling clause label');
ok(fires('their best seller is undefined this week', 'R-TEXT-03'), 'R-TEXT-03 placeholder junk');
ok(fires('hook: "Will these fit my couch — plus more', 'R-QUOTE-01'), 'R-QUOTE-01 unbalanced quote');
ok(fires('the ads send traffic to Facebook’s login page', 'R-PHRASE-01'), 'R-PHRASE-01 banned login-page phrasing');
ok(fires('runs from a third-party page', 'R-PHRASE-02'), 'R-PHRASE-02 vague third-party page');
ok(fires('Ad landing domain x.com now redirects to y.com', 'R-CLAIM-01'), 'R-CLAIM-01 domain-wide redirect claim');
ok(fires('Storefront promo first seen 2026-08-11 on the banner', 'R-DATE-01'), 'R-DATE-01 raw ISO date in brief');

console.log('\nDELIVERY GATE — clean lines pass:');
ok(clean('18 new ads launched since yesterday (all video) — newest opens: "Will these fit?" → nolaninterior.com.'), 'good gate line passes');
ok(clean('New ad launched 2026-08-05 — video from “The Oodie”.'), 'launch date is allowed');
ok(clean('Ad landing page x.com/lp redirected to y.com/p when checked on 2026-08-11 — that ad’s traffic ends up on y.com, a different site. (One ad URL tested, not the whole x.com domain.)'), 'scoped redirect claim passes');
ok(fires('Storefront: 2 new products listed (2026-08-10 → 2026-08-11).', 'R-PROV-01'), 'R-PROV-01 date-range window fires (overturned 12 Aug: daily cadence makes it implicit)');
ok(fires('Storefront compared 2026-08-11 → 2026-08-12: prices unchanged.', 'R-PROV-01'), 'R-PROV-01 "compared" phrasing fires');
ok(clean('Storefront unchanged — same prices, products and sale.'), 'absolute no-change line passes');
ok(clean('Cadence runs ~2.8 emails/week; offers rotate across 30% off and BOGO.'), 'normal email read passes');

console.log('\nDELIVERY GATE — fallback behaviour:');
const qa = [];
const g1 = gateLine('79 active — same creatives.', '3 new ads captured — details in the app.', { surface: 'slack', qa, brand: 'X', channel: 'ads' });
ok(g1.downgraded && g1.text.indexOf('active') < 0, 'violating line downgrades to fallback');
ok(qa.length === 1 && qa[0].rules.indexOf('R-ADS-01') >= 0, 'downgrade is QA-logged with rule id');
const g2 = gateLine('all good here.', '', { surface: 'slack' });
ok(!g2.downgraded && g2.text === 'all good here.', 'clean line ships untouched');
const g3 = gateLine('79 active.', '98 of 200 ads.', { surface: 'slack' });
ok(g3.downgraded && g3.text.indexOf('ads') < 0, 'violating fallback is rejected too (generic stub)');

console.log('\nSELF-AUDIT — the Seranova class of miss:');
const facts = [{ name: 'Seranova', host: 'seranova.com', sale: 'Sale live: Back to School Sale: up to 58% off', products: 0, staleOffers: 0 }];
const briefMissing = '*Seranova* 🔹 routine activity\n   📣 Ads: 24 new ads launched since yesterday (18 video, 6 image).';
const briefOk = '*Seranova* 💡\n   🛒 Website: Back to School Sale live — up to 58% off.';
ok(checkMisses(briefMissing, facts).some((v) => v.rule === 'R-MISS-01'), 'live sale absent from brief → R-MISS-01 fires');
ok(checkMisses(briefOk, facts).length === 0, 'sale mentioned → no miss');
ok(checkMisses('*Other* block only', facts).some((v) => v.rule === 'R-MISS-00'), 'brand with signals but no block → R-MISS-00');

console.log('\nEMAIL PREVIEWS — quoted-printable repair:');
ok(repairPreview('=E2=80=8C=C2=A0=E2=80=8C=C2=A0 2-In-1 =C2=B7 SPF 50. T= wo Jobs.') === '2-In-1 · SPF 50. Two Jobs.', 'QP garbage decodes to real text');
ok(repairPreview('[500,000+ Women =C2=B7 Approved by Germany’s Testing = Institute. SE= E HOW]') .indexOf('=') < 0, 'low-escape QP with soft breaks decodes');
ok(repairPreview('Plain preview text, price = 42 stays.') === 'Plain preview text, price = 42 stays.', 'plain text with a legit = untouched');
ok(repairPreview('story =E2=80=8C=E2=80=8C=E2=80=8C=E2=8') === 'story', 'truncated escape tail dropped cleanly');

console.log('\nADS PAGES — quoted names are labelled as handles (founder, 12 Aug):');
const two = adsFindings([
  { day: '2026-08-12', data: { ads: [
    { id: 'h1', landing: 'https://x.com/a', page: 'Seranova', started: '2026-08-12' },
    { id: 'h2', landing: 'https://x.com/b', page: 'Daily Discounts Online', started: '2026-08-11' },
  ] } },
  { day: '2026-08-11', data: { ads: [ { id: 'h1', landing: 'https://x.com/a', page: 'Seranova', started: '2026-08-10' } ] } },
], 50).find((f) => f.key === 'ads.footprint');
ok(two && / handles\.$/.test(two.text) && two.text.indexOf('"Daily Discounts Online"') > 0, 'multiple pages end with "handles."');
const one = adsFindings([
  { day: '2026-08-12', data: { ads: [ { id: 'h1', landing: 'https://x.com/a', page: 'Seranova', started: '2026-08-12' } ] } },
], 50).find((f) => f.key === 'ads.footprint');
ok(one && / handle\.$/.test(one.text), 'a single page ends with "handle."');

console.log('\nLAUNCH GATE LINE — "all video" needs a plural (founder, 12 Aug):');
const oneAd = adsFindings([
  { day: '2026-08-12', data: { ads: [
    { id: 'g1', landing: 'https://glov.com/a', page: 'Glov', started: '2026-08-11', hasVideo: true },
    { id: 'g0', landing: 'https://glov.com/b', page: 'Glov', started: '2026-07-01' },
  ] } },
  { day: '2026-08-11', data: { ads: [ { id: 'g0', landing: 'https://glov.com/b', page: 'Glov', started: '2026-07-01' } ] } },
], 50).find((f) => f.key === 'ads.launches');
ok(oneAd && /\(video\)/.test(oneAd.text) && oneAd.text.indexOf('all video') < 0, 'one ad → "(video)", never "(all video)"');
const twoAds = adsFindings([
  { day: '2026-08-12', data: { ads: [
    { id: 'g1', landing: 'https://glov.com/a', page: 'Glov', started: '2026-08-11', hasVideo: true },
    { id: 'g2', landing: 'https://glov.com/c', page: 'Glov', started: '2026-08-12', hasVideo: true },
    { id: 'g0', landing: 'https://glov.com/b', page: 'Glov', started: '2026-07-01' },
  ] } },
  { day: '2026-08-11', data: { ads: [ { id: 'g0', landing: 'https://glov.com/b', page: 'Glov', started: '2026-07-01' } ] } },
], 50).find((f) => f.key === 'ads.launches');
ok(twoAds && /\(all video\)/.test(twoAds.text), 'two uniform ads → "(all video)"');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
