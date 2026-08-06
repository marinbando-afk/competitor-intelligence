// REGRESSION FIXTURES — one case per trust failure the founder caught.
//
// A fix without a test is a fix that survives until the next code path (the 29 Jul guard on
// "pages dropped" held in the signal layer, then the same claim came back through the AI
// read). Each case below is a real sentence that reached a real brief, paired with the real
// capture facts. They must stay blocked. Run: node test/claims.test.js
import { checkClaims } from '../src/claims.js';

let pass = 0, fail = 0;
function t(name, text, facts, shouldBlock, expectRule) {
  const v = checkClaims(text, facts);
  const blocked = v.length > 0;
  const ok = blocked === shouldBlock && (!expectRule || (v[0] && v[0].rule === expectRule));
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + '\n      got: ' + (blocked ? v.map((x) => x.rule).join(',') : 'ALLOWED') + ' | wanted: ' + (shouldBlock ? 'blocked' + (expectRule ? ' (' + expectRule + ')' : '') : 'allowed')); }
}

console.log('\nMUST BLOCK — real sentences that reached real briefs:');

// Glov, 1 Aug — capture was at the collection cap; the pages were never retired.
t('Glov: nine persona pages "dropped"',
  'Whitelisting tactic gone: all nine creator/persona pages dropped, every ad now branded.',
  { canJudgeAbsence: false, hasEarlier: true, comparable: true }, true, 'ended');

// Seranova, 2 Aug — Dr. Annie Gonzalez appears in that very day's capture.
t('Seranova: page "has gone quiet"',
  "'Dr. Annie Gonzalez, MD' whitelisting Facebook page has gone quiet — all five persona pages now run identical copy.",
  { canJudgeAbsence: false, hasEarlier: true, comparable: true }, true, 'ended');

// Tallowed Truth, 31 Jul — the balm was listed every day since 15 Jul; only variants were added.
t('Tallowed Truth: variant listings called a launch',
  'Freedom Field Balm launched today (31 Jul) in at least 4 variants — their first new product since monitoring began 15 Jul.',
  { hasEarlier: true, canAssertNew: true, genuineNewProduct: false, comparable: true }, true);

// Casa and Beyond, 30 Jul — first ever capture; only our monitoring started that day.
t('Casa and Beyond: baseline day reported as a launch',
  '50% Off Clearance Sale launched today (30 Jul) — items originally $49.99-$139.99, now half price site-wide.',
  { hasEarlier: false, canJudgeAbsence: false, comparable: false }, true, 'launched');

// CurrentBody, 29 Jul — same-day pair with no product feed.
t('CurrentBody: price move with no comparable feed',
  'Three LED products raised in price today: Face Mask +$100, Tighten & Brighten Kit +$90.',
  { priceComparable: false, comparable: false, hasEarlier: true }, true);

// Froya, 27 Jul — partial vision read of a banner that had run for weeks.
t('Froya: read variance reported as a replacement',
  "'1M Jars Sold' sale went live today (27 Jul) replacing a generic 40%-off bar.",
  { hasEarlier: true, canAssertNew: false, comparable: true }, true);

// Founder rules that predate the validator.
t('day counter', 'Fake sale: "Black Friday" still live — running 241 days.', { canJudgeAbsence: true }, true, 'durationDays');
t('capture counting', 'Meta ads completely off — no spend for 2+ consecutive captures.', { canJudgeAbsence: true }, true, 'captureCount');
t('guessed identity', "The Valentine's ad is most likely from Nordic Wellness Secrets.", { hasEarlier: true }, true, 'guessIdentity');

// Tallowed Truth, 2 Aug — caught by the validator itself during a routine audit. Their
// social capture holds the newest 9 posts; three new Reels pushed a Carousel out of view and
// the read called it a replacement. The post was never removed.
t('Tallowed Truth: social window rotation called a replacement',
  "Three product-focused Reels added since last capture, replacing a political 'Sorry not sorry' Carousel.",
  { canJudgeAbsence: false, comparable: false, hasEarlier: true }, true, 'replaced');

// UKLASH, 2 Aug — one unchanged subscription offer, transcribed four different ways in four
// days; the re-ordered read defeated the containment test and was announced as a launch.
t('UKLASH: re-worded banner reported as a launch',
  "Subscription sale launched on-site today (2 Aug): 25% off entry offer plus 15% off every repeat order — first time this framing has appeared in the announcement bar.",
  { hasEarlier: true, canAssertNew: false, comparable: true }, true);

// UKLASH, 3 Aug — the app showed this headline directly above its own panel reading "No
// changes since the last capture". The 3 Aug capture caught a rotating shipping slide, so no
// sale was even seen that day.
t('UKLASH: read contradicts the computed diff',
  'New subscription-discount sale live today: 15% off forever, 25% off today, bigger subscription discounts.',
  { hasEarlier: true, comparable: true, noChanges: true }, true, 'contradictsDiff');

t('UKLASH: "first appearance in monitoring" on an unchanged day',
  'Sale started 3 Aug: 15% off forever, 25% off today, and deeper subscription discounts — first appearance in monitoring.',
  { hasEarlier: true, comparable: true, noChanges: true }, true);

// Pannonian Padel, 5 Aug — no IG/TikTok/Facebook handles were ever stored, so we had never
// looked; the brief still reported them as quiet.
t('Pannonian Padel: quiet claimed on an unmonitored channel',
  'No new posts across Instagram, TikTok, or Facebook — all content unchanged.',
  { channelConnected: false, canJudgeAbsence: false, hasEarlier: true }, true, 'quietWithoutData');

// Casa and Beyond, 4 Aug — .com.au had been the destination since 31 Jul; the 3rd and 4th
// captured 3 and 2 ads out of a typical ~30, so the "switch" was sampling noise.
t('Casa and Beyond: destination switch from a thin sample',
  'Ad destination switched from casaandbeyond.com to casaandbeyond.com.au today — they are now actively targeting Australian shoppers.',
  { comparable: true, hasEarlier: true, sampleReliable: false }, true, 'replaced');

// The founder, 6 Aug: "STOP REPORTING INSIGHTS AS NEW if they are not NEW". Newness is now
// proven per ITEM against everything seen in earlier captures.
t('a domain seen before cannot be new',
  'New funnel: casaandbeyond.com.au is now their ad destination.',
  { hasEarlier: true, comparable: true, sampleReliable: true, knownEntities: ['casaandbeyond.com.au', 'casaandbeyond.com'] }, true, 'staleNew');

t('a page seen before cannot be new',
  'New Facebook page running their ads: Dr. Annie Gonzalez, MD.',
  { hasEarlier: true, comparable: true, canJudgeAbsence: true, knownEntities: ['Dr. Annie Gonzalez, MD', 'Seranova'] }, true, 'staleNew');

// TRACEABILITY — a change claim must correspond to a computed finding.
t('change claim with no matching finding is untraceable',
  'They switched their ad destination to a new landing page today.',
  { hasEarlier: true, comparable: true, sampleReliable: true, changeFindings: [] }, true, 'untraceable');

t('change claim naming an unrelated entity is untraceable',
  'A new funnel bonafide.us appeared in their ads.',
  { hasEarlier: true, comparable: true, sampleReliable: true, changeFindings: ['Storefront: 1 product removed — Triangle Poncho'] }, true);

// The DRM LAB, 6 Aug — 79 ads captured, all from their own page, reported as "all ads".
t('universal claim from a sample',
  'The DRM LAB runs all ads from their own branded page to advertorial landing pages.',
  { hasEarlier: true, comparable: true, sampleReliable: true }, true, 'completeness');

console.log('\nMUST ALLOW — correct reporting must not be over-blocked:');

t('honest absence wording',
  "Dr. Annie Gonzalez was not seen in today's capture; their other four persona pages are still running.",
  { canJudgeAbsence: false, hasEarlier: true }, false);

t('baseline stated honestly',
  'Clearance Sale at 50% off is live on their website; already running when monitoring began (30 Jul), true start date unknown.',
  { hasEarlier: false, comparable: false }, false);

t('unchanged sale with a date',
  "'Up to 40% off - 1M Jars Sold' sale active and unchanged since 15 Jul.",
  { hasEarlier: true, comparable: true }, false);

t('genuine launch with evidence',
  'Sauna Blanket launched today — it was absent from every earlier capture.',
  { hasEarlier: true, canAssertNew: true, genuineNewProduct: true, comparable: true }, false);

t('price test called out correctly',
  'Freedom Field Balm is now listed 5 times at four prices ($29.99-$44.99) — active price testing on their site.',
  { priceComparable: true, comparable: true, hasEarlier: true, genuineNewProduct: false }, false);

// NB: the validator rejected the first draft of this fixture for saying "since the last
// capture" — banned plumbing language. It was right; the sentence now uses a date.
t('social: appearance is reportable',
  'Three product-focused Reels appeared on 1 Aug — their first product content since 23 Jul.',
  { canJudgeAbsence: false, comparable: false, hasEarlier: true, canAssertNew: true, genuineNewProduct: true }, false);

// Found by the nightly quality audit itself, 4 Aug — both were MY rules being wrong.
t('release sense of "dropped" is not an ending',
  'Harry Potter x The Oodie dropped today on TikTok and Facebook — their biggest IP collab signal yet.',
  { canJudgeAbsence: false, hasEarlier: true, comparable: true }, false);

t('counter-op advice may talk about price cuts',
  'Test a time-limited genuine offer to contrast against their always-on compare-at discount — make your price cut feel real.',
  { priceComparable: false, advice: true, hasEarlier: true }, false);

t('quiet is reportable when the account IS connected',
  'No new posts on Instagram since 28 Jul — their last post was the lash tutorial.',
  { channelConnected: true, canJudgeAbsence: true, hasEarlier: true, comparable: true }, false);

t('destination switch IS reportable from a full capture',
  'Ad destination switched to casaandbeyond.com.au — every ad in a full capture now lands there.',
  { comparable: true, hasEarlier: true, sampleReliable: true, canJudgeAbsence: true }, false);

t('a genuinely unseen entity may be called new',
  'New funnel: shopcasa.io appeared in their ads today.',
  { hasEarlier: true, comparable: true, sampleReliable: true, canAssertNew: true, knownEntities: ['casaandbeyond.com.au', 'casaandbeyond.com'] }, false);

t('change claim backed by a finding passes',
  'A new funnel shopcasa.io appeared in their ads today.',
  { hasEarlier: true, comparable: true, sampleReliable: true, canAssertNew: true,
    changeFindings: ['Ad landing domain shopcasa.io appears for the first time; it was absent from every earlier capture that held ads.'] }, false);

t('present-tense description needs no finding',
  'Ads run to casaandbeyond.com.au from their own Casa & Beyond page.',
  { hasEarlier: true, comparable: true, changeFindings: [] }, false);

t('scoped completeness is fine',
  'All 79 ads in today\'s capture run from their own branded page to advertorial landing pages.',
  { hasEarlier: true, comparable: true, sampleReliable: true }, false);

t('legitimate end-of-tactic on a healthy capture',
  'Their advertorial page dropped out entirely — no ads from it in a full capture that also grew day over day.',
  { canJudgeAbsence: true, hasEarlier: true, comparable: true }, false);

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);

// ── banner sameness (occasions.sameBannerText) ────────────────────────────────
import { sameBannerText } from '../src/occasions.js';
console.log('\nBANNER SAMENESS — re-wording is not a new promo:');
function b(name, x, y, want) {
  const got = sameBannerText(x, y);
  if (got === want) { console.log('  ✓ ' + name); } else { console.log('  ✗ ' + name + ' (got ' + got + ')'); process.exitCode = 1; }
}
b('UKLASH: re-ordered same offer', '25% off today, 15% off forever with subscription', '15% OFF FOREVER + LIMITED TIME ONLY + 25% OFF TODAY + EVEN BIGGER SUBS', true);
b('Froya: partial vs full read', 'UP TO 40% OFF', 'UP TO 40% OFF 1M JARS SOLD', true);
b('Seranova: genuine rename stays different', 'Summer Sale: 58% off', '4th of July Sale: 58% off', false);
b('genuine depth change stays different', '25% Off Today + 15% Off Forever', '50% off everything sitewide', false);

// ── handle normalisation (social.normHandle) ──────────────────────────────────
// Pannonian Padel, 5 Aug: handles WERE submitted, but the confirm modal stores what the
// client pastes — usually a full profile URL — and the scraper only stripped a leading "@".
// It queried for "instagram.com/pannonianpadel", found nothing, and the brand showed zero
// posts for weeks while reports called them quiet.
import { normHandle } from '../src/social.js';
console.log('\nHANDLE NORMALISATION — a pasted URL must still scrape:');
function h(inp, want) {
  const got = normHandle(inp);
  if (got === want) console.log('  ✓ ' + JSON.stringify(inp));
  else { console.log('  ✗ ' + JSON.stringify(inp) + ' -> ' + JSON.stringify(got) + ' (want ' + JSON.stringify(want) + ')'); process.exitCode = 1; }
}
h('instagram.com/pannonianpadel', 'pannonianpadel');
h('https://www.tiktok.com/@pannonianpadel', 'pannonianpadel');
h('facebook.com/profile.php?id=100067470427617', 'profile.php?id=100067470427617');
h('facebook.com/p/Mars-Men-184711951390377/', 'p/Mars-Men-184711951390377');
h('@the_oodie', 'the_oodie');
h('the_oodie', 'the_oodie');
h('https://instagram.com/glovbeauty/', 'glovbeauty');
