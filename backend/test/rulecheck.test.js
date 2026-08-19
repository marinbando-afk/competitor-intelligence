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
ok(fires('21 new ads launched since 2026-08-13 (18 video, 3 image).', 'R-DATE-01'), 'launched-since-ISO fires — the launch line is a one-day window (R-LAUNCH-WINDOW; Nolan, 15 Aug)');
ok(clean('6 new ads launched since yesterday (all video) — newest opens: "Tired of pet hair" → casaandbeyond.com.au.'), 'the Casa format is the spec and passes clean');
ok(clean('New ad launched 2026-08-05 — video from “The Oodie”.'), 'launch date is allowed');
ok(clean('Ad landing page x.com/lp redirected to y.com/p when checked on 2026-08-11 — that ad’s traffic ends up on y.com, a different site. (One ad URL tested, not the whole x.com domain.)'), 'scoped redirect claim passes');
// Flipped 13 Aug: R-PROV-01 + R-DATE-01 now deliberately ban comparison windows and raw
// ISO dates in briefs (daily cadence makes the window implicit) — the old allowance is stale.
ok(fires('Storefront: 2 new products listed (2026-08-10 → 2026-08-11).', 'R-PROV-01'), 'comparison windows fire in briefs');
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

console.log('\nFALLBACK SUBSTANCE — pinned so a merge can never clobber it again (18 Aug, Bare Bones stub):');
const { socialRowText, emailRowText, safeQuote } = await import('../src/slack.js');
ok(socialRowText('', [{ platform: 'Instagram', count: 1, about: 'Play your comfort card with UNO' }], 9).indexOf('New Instagram post: ') === 0, 'social fallback quotes the hook, never \u201cdetails in the app\u201d');
ok(socialRowText('', [], 9) === 'No new posts on the tracked profiles.', 'no new posts → honest row');
ok(emailRowText('', 0, 16, 'Smooche is now on Amazon!').indexOf('No new emails — latest:') === 0, 'email fallback carries the latest subject');
const nasty = 'Check this \u201cdeal\u201d https://x.com/p?utm_source=fb before 2026-08-11';
ok(checkText(socialRowText('', [{ platform: 'TikTok', count: 1, about: nasty }], 3), { surface: 'slack' }).length === 0, 'safeQuote makes a hostile hook (curly quote + UTM link + ISO date) gate-clean');
const chain = gateLine('New Instagram item since 2026-08-11: \u201cx\u201d.', socialRowText('', [{ platform: 'Instagram', count: 1, about: nasty }], 3), { surface: 'slack' });
ok(chain.downgraded && chain.text.indexOf('New Instagram post: ') === 0, 'violating read → substantive fallback ships, never the stub');
ok(safeQuote('a  b   c') === 'a b c' && safeQuote('') === '', 'safeQuote basics');

console.log('\nREPEAT CAP — 3 mornings of news, then 30 days of quiet (founder, 18 Aug):');
const { repeatCapNext } = await import('../src/findings.js');
let rc = repeatCapNext(null, '2026-08-18');
ok(rc.emit && rc.next.streak === 1, 'day 1: emits');
rc = repeatCapNext({ streak: 2, last: '2026-08-17', mutedUntil: '' }, '2026-08-18');
ok(rc.emit && rc.next.streak === 3, 'day 3: still emits');
rc = repeatCapNext({ streak: 3, last: '2026-08-17', mutedUntil: '' }, '2026-08-18');
ok(!rc.emit && rc.next.mutedUntil === '2026-09-17', 'day 4: muted for 30 days');
ok(!repeatCapNext({ streak: 0, last: '2026-08-17', mutedUntil: '2026-09-17' }, '2026-09-01').emit, 'mid-mute: stays quiet');
rc = repeatCapNext({ streak: 0, last: '2026-08-17', mutedUntil: '2026-09-17' }, '2026-09-17');
ok(rc.emit && rc.next.streak === 1, 'after the mute: reminds once and the cycle restarts');
ok(repeatCapNext({ streak: 2, last: '2026-08-18', mutedUntil: '' }, '2026-08-18').emit, 'same-day rerun: idempotent, still emits');

console.log('\nWEBSITE FALLBACK TIER — violating read falls to the honest no-change line (Froya, 18 Aug):');
const gWeb = gateLine('Storefront promo first seen 2026-08-11 on the banner.', 'Storefront unchanged — same prices, products and sale.', { surface: 'slack' });
ok(gWeb.downgraded && gWeb.text === 'Storefront unchanged — same prices, products and sale.', 'website stub is unreachable when the pair was comparable');

console.log('\nBANNER HYGIENE — model commentary in a data field can never ship (CurrentBody Grazia, 19 Aug):');
const { cleanBannerText, isPressQuoteBanner, isSaleBanner } = await import('../src/occasions.js');
const poisoned = 'Beauty technology at its finest." - Grazia" (This is a press quote, not a promotional offer/sale.)';
ok(cleanBannerText(poisoned) === 'Beauty technology at its finest." - Grazia', 'cleanBannerText strips the meta-caveat and the orphan quote');
ok(!isSaleBanner(poisoned), 'poisoned banner: the word "sale" inside the model caveat no longer flips isSaleBanner');
ok(!isSaleBanner('Beauty technology at its finest." - Grazia'), 'clean press quote is never a sale banner (R-BANNER-PRESS)');
ok(isPressQuoteBanner('"The best balm we tested" — Vogue'), 'quote + dash-attributed source detected as press quote');
ok(isSaleBanner('SUMMER SALE — up to 40% off'), 'a real sale banner still classifies as a sale');
ok(isSaleBanner('Back to School Sale, up to 58% off'), 'occasion-named sale still classifies');
ok(fires('Storefront promo: "Beauty technology at its finest." - Grazia" (This is a press quote, not a promotional offer/sale.)" — unchanged across recent captures.', 'R-META-01'), 'R-META-01 gates model self-talk out of any surface');
ok(clean('Storefront promo: "Back to School Sale, up to 58% off" — unchanged across recent captures.'), 'a genuine promo line still passes the gate');

console.log('\nMARK FOLLOWS TEXT — the website ❗ derives from the shipped sentence (Glov, 19 Aug):');
const { textClaimsWebNews } = await import('../src/slack.js');
ok(!textClaimsWebNews("Summer Sale unchanged — 'Shop Summer Sale' still promoted, prices steady."), 'standing sale + steady prices → no mark');
ok(!textClaimsWebNews('Storefront unchanged — same prices, products and sale.'), 'no-change line → no mark');
ok(textClaimsWebNews('*New sale live* — “Back to School Sale, up to 58% off”'), 'new sale announcement → mark');
ok(textClaimsWebNews('*Sale live (already running)* — “Subscribe & save 20%”'), 'catch-up announcement (first report) → mark');
ok(textClaimsWebNews('“Original Tallow Balm”  $44 → $39'), 'price move → mark');
ok(textClaimsWebNews('Storefront: 2 new products listed — Dry Body Oil, Honey Balm'), 'new products → mark');
ok(!textClaimsWebNews('No new products; catalogue steady.'), '"no new …" phrasing never false-positives');

console.log('\nCONGRUENCE R-SYNC-05 — a promo announced in the brief must exist in the app read (CurrentBody, 19 Aug):');
const { checkCongruence } = await import('../src/qa.js');
const blockCB = '*Current Body*\n   *Website:* Storefront promo: "Beauty technology at its finest." - Grazia — unchanged across recent captures.';
const readCB = { website: { summary: 'Storefront unchanged — same prices, products and sale.' } };
ok(checkCongruence(blockCB, readCB, { name: 'Current Body' }).some((v) => v.rule === 'R-SYNC-05'), 'Slack promo vs app "unchanged" → R-SYNC-05 ping');
const readOK = { website: { summary: 'Back to School Sale live, up to 58% off — unchanged.' } };
ok(!checkCongruence('*X*\n   *Website:* *New sale live* — “Back to School Sale”', readOK, { name: 'X' }).some((v) => v.rule === 'R-SYNC-05'), 'promo present in both surfaces → no ping');

console.log('\nNEW FUNNEL PATH — a first-seen landing PATH with 3+ ads is news even on the own domain (Ancestral, 19 Aug):');
const mkAd = (landing, page) => ({ id: Math.random().toString(36).slice(2), landing, page, started: '2026-08-13' });
const oldAds = Array.from({ length: 5 }, () => mkAd('https://ancestralcosmetics.com/products/original-tallow-honey-balm', 'Ancestral Cosmetics'));
const newLP = Array.from({ length: 4 }, () => mkAd('https://ancestralcosmetics.com/pages/we-made-face-cream-from-beef-fat', 'Mihael Sanko Founder of Ancestral Cosmetics'));
const fRows = [
  { day: '2026-08-13', data: { ads: [...oldAds, ...newLP] } },
  { day: '2026-08-12', data: { ads: oldAds } },
  { day: '2026-08-11', data: { ads: oldAds } },
];
const fOut = adsFindings(fRows, 100);
const fp = fOut.find((f) => f.key && f.key.indexOf('ads.newPath:') === 0);
ok(!!fp, 'R-FUNNEL-PATH: new own-domain landing path with 4 ads → new-funnel finding');
ok(fp && /we-made-face-cream-from-beef-fat/.test(fp.text) && /Mihael Sanko/.test(fp.text), 'finding names the path and the handle');
ok(fp && !/\b\d+\s+ads\b/i.test(fp.text), 'finding text carries no ad count (sample-size rule)');
const fOut2 = adsFindings([{ day: '2026-08-14', data: { ads: [...oldAds, ...newLP] } }, ...fRows], 100);
ok(!fOut2.some((f) => f.key && f.key.indexOf('ads.newPath:') === 0), 'the same path the next day is no longer new');
const oneOff = [mkAd('https://ancestralcosmetics.com/pages/typo-variant', 'Ancestral Cosmetics')];
const fOut3 = adsFindings([{ day: '2026-08-13', data: { ads: [...oldAds, ...oneOff] } }, { day: '2026-08-12', data: { ads: oldAds } }], 100);
ok(!fOut3.some((f) => f.key && f.key.indexOf('ads.newPath:') === 0), 'a single-ad path stays below the 3-ad threshold');

console.log('\nFUNNEL CATCH-UP — captured is NOT announced (Ancestral beef-fat funnel, live since 13 Aug):');
const { funnelCatchupNext } = await import('../src/findings.js');
// Today is Aug 19; the funnel path has been in captures since Aug 13 — 6 days, inside the window.
const cuRows = [
  { day: '2026-08-19', data: { ads: [...oldAds, ...newLP] } },
  { day: '2026-08-14', data: { ads: [...oldAds, ...newLP] } },
  { day: '2026-08-13', data: { ads: [...oldAds, ...newLP] } },
  { day: '2026-08-12', data: { ads: oldAds } },
];
const cu = adsFindings(cuRows, 100).find((f) => f.key && f.key.indexOf('ads.funnelCatchup:') === 0);
ok(!!cu, 'a running-but-never-announced recent funnel fires as catch-up');
ok(cu && /already running/.test(cu.text) && /began on 2026-08-13/.test(cu.text), 'catch-up says already running + when it began');
ok(cu && !fires(cu.text, 'R-DATE-01'), '"began on <date>" phrasing is gate-exempt');
const oldRows = [
  { day: '2026-08-19', data: { ads: [...oldAds, ...newLP] } },
  { day: '2026-07-01', data: { ads: [...oldAds, ...newLP] } },
  { day: '2026-06-30', data: { ads: oldAds } },
];
ok(!adsFindings(oldRows, 100).some((f) => f.key && f.key.indexOf('ads.funnelCatchup:') === 0), 'a funnel older than the window is scenery, not missed news');
ok(funnelCatchupNext(undefined, '2026-08-19'), 'never announced → emit');
ok(funnelCatchupNext('2026-08-19', '2026-08-19'), 'announced today (same-day rerun) → still emits, idempotent');
ok(!funnelCatchupNext('2026-08-18', '2026-08-19'), 'announced yesterday → never repeats');

console.log('\nFUNNEL LEAD — a new funnel gets the biggest priority on every surface (founder, 19 Aug):');
ok(fOut[0] && String(fOut[0].key).indexOf('ads.newPath:') === 0, 'the new-funnel finding LEADS the ads findings list');
const launchF = fOut.find((f) => f.key === 'ads.launches');
ok(launchF && /the NEW funnel ancestralcosmetics\.com\/pages\/we-made-face-cream-from-beef-fat/.test(launchF.text), 'the launch line itself names the NEW funnel, not just the bare domain');
const { textClaimsFunnel } = await import('../src/slack.js');
ok(textClaimsFunnel('4 new ads launched today — all driving to the NEW funnel x.com/pages/lp'), 'ads row naming a new funnel → ❗');
ok(textClaimsFunnel('Ad funnel live (already running): multiple ads drive to x.com/p — the funnel began on 2026-08-13.'), 'catch-up wording → ❗');
ok(!textClaimsFunnel('Recent ads run to x.com and from "X" handle.'), 'plain footprint → no ❗ from funnel check');
const missF = checkMisses('*Brand X*\n   *Ads:* Recent ads run to x.com and from "X" handle.', [{ name: 'Brand X', funnels: 1, sale: '', products: 0, staleOffers: 0, postsSeen: 0, emailsSeen: 0 }]);
ok(missF.some((v) => v.rule === 'R-MISS-06'), 'computed funnel absent from the brief block → R-MISS-06 ping');
const missOK = checkMisses('*Brand X*\n   *Ads:* 4 new ads launched — all driving to the NEW funnel x.com/pages/lp.', [{ name: 'Brand X', funnels: 1, sale: '', products: 0, staleOffers: 0, postsSeen: 0, emailsSeen: 0 }]);
ok(!missOK.some((v) => v.rule === 'R-MISS-06'), 'funnel named in the block → no ping');

console.log('\nSENSE-CHECK FACTS — the checker sees everything the writer saw (Ancestral splice, 19 Aug):');
const { senseFacts } = await import('../src/insights.js');
const sf = senseFacts([{ text: 'Ad funnel live (already running): multiple ads drive to x.com/pages/lp — the funnel began on 2026-08-13.' }], 'RAW ADS FACTS HERE');
ok(sf.indexOf('funnel began on 2026-08-13') >= 0 && sf.indexOf('RAW ADS FACTS HERE') >= 0, 'computed findings prepend the raw facts for the sense check');
ok(sf.indexOf('COMPUTED FINDINGS') === 0, 'findings are framed as supported facts, so the checker cannot splice them out');
ok(senseFacts(null, 'JUST FACTS') === 'JUST FACTS', 'no findings → facts pass through unchanged');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
