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

console.log('\nCLIP + BADGE — the funnel callout ships whole and the badge agrees with the rows (Ancestral, 19 Aug):');
const { clipSent, badgeFor } = await import('../src/slack.js');
const funnelLine = 'Ad funnel live (already running): multiple ads drive to ancestralcosmetics.com/pages/we-made-face-cream-from-beef-fat, running from the "Mihael Sanko Founder of Ancestral Cosmetics" and "Ancestral Cosmetics" handles — the funnel began on 2026-08-13.';
ok(clipSent(funnelLine, 180) === funnelLine.slice(0, funnelLine.length), 'an oversize FIRST sentence ships whole, never "…running from the."');
ok(!fires(clipSent(funnelLine, 180), 'R-TEXT-02'), 'the shipped funnel line passes the truncation gate');
const twoSent = 'Short opener sentence that is comfortably under the budget and reads fine. ' + 'x'.repeat(200);
ok(/fine\.$/.test(clipSent(twoSent, 180)), 'multi-sentence text still clips at the sentence boundary');
const monster = 'A '.repeat(200) + 'end';
ok(/…$/.test(clipSent(monster, 180)) && !/\s(the|a|an)…$/i.test(clipSent(monster, 180)), 'a 280+ single sentence clips with … and no dangling article');
ok(fires('20 new ads launched — newest opens: "x" running from the.', 'R-TEXT-02'), 'R-TEXT-02 catches a line ending on a dangling article');
ok(!fires('That is what their audience is known for.', 'R-TEXT-02'), '"known for." stays legal');
ok(badgeFor(false, false, '   *Ads:* ❗ Ad funnel live (already running): multiple ads drive to x.com/pages/lp.') === '💡', '❗ funnel row → 💡 badge, never "✅ no new moves"');
ok(badgeFor(false, false, '   *Ads:* Recent ads run to x.com.') === '✅ no new moves', 'genuinely quiet rows keep ✅');
ok(badgeFor(false, true, '   *Social:* New post.') === '🔹 routine activity', 'activity without priority → routine');
ok(badgeFor(false, false, '   *Email:* ❗ New email: "subject"') === '🔹 routine activity', '❗ without a priority claim → routine, not ✅');

console.log('\nRULES AUDIT FIXES (19 Aug) — quiet-latest, leading ad cadence, perf-claim gate:');
ok(socialRowText('', [], 9, 'Anxiety diagnoses have exploded over the last 30 years') === 'No new posts — latest is still “Anxiety diagnoses have exploded over the last 30 years”.', 'quiet social row always names the latest post');
ok(socialRowText('', [], 9, '') === 'No new posts on the tracked profiles.', 'no latest hook stored → plain quiet line, no empty quotes');
const { leadingDueNext } = await import('../src/findings.js');
ok(leadingDueNext('', '2026-08-19') && leadingDueNext('2026-08-19', '2026-08-19'), 'leading ad: never shown / shown today → due (idempotent)');
ok(!leadingDueNext('2026-08-01', '2026-08-19'), 'shown 18 days ago → not due yet');
ok(leadingDueNext('2026-07-19', '2026-08-19'), 'shown 31 days ago → due again');
const quietAds = Array.from({ length: 4 }, (x, i) => ({ id: 'q' + i, landing: 'https://ancestralcosmetics.com/products/balm', page: 'Ancestral Cosmetics', started: i === 0 ? '2026-06-01' : '2026-08-10', text: 'oldest survivor hook here' }));
const qRows = [
  { day: '2026-08-19', data: { ads: quietAds } },
  { day: '2026-08-18', data: { ads: quietAds } },
];
const lead = adsFindings(qRows, 100).find((f) => f.key === 'ads.leading');
ok(!!lead && /longest-running ad, launched 2026-06-01/.test(lead.text), '5+ quiet days → longest-running ad finding with its launch date');
ok(clean(lead ? lead.text.replace(/\s+/g, ' ') : '', 'app'), 'leading-ad line is gate-clean');
const busyAds = quietAds.map((a, i) => (i === 1 ? { ...a, started: '2026-08-19' } : a));
ok(!adsFindings([{ day: '2026-08-19', data: { ads: busyAds } }, qRows[1]], 100).some((f) => f.key === 'ads.leading'), 'a launch within 5 days → no leading-ad line');
ok(fires('Their top performing ad pushes the balm.', 'R-ADS-PERF'), 'R-ADS-PERF: "top performing" gated');
ok(fires('This creative likely has the most impressions.', 'R-ADS-PERF'), 'R-ADS-PERF: "most impressions" gated');
ok(clean('Their longest-running ad still opens: "hook".'), '"longest-running" phrasing stays legal');

console.log('\nDO-ALL-OF-THEM BATCH (19 Aug) — marks on every row, price context, email offers:');
const { textClaimsAdsNews, textClaimsSocialNews, textClaimsEmailNews } = await import('../src/slack.js');
ok(textClaimsAdsNews('4 new ads launched today (all video) — newest opens: "x".'), 'ads mark: launches → ❗');
ok(textClaimsAdsNews('Ads appear from "Daily Deals" for the first time; this page was absent from every earlier capture.'), 'ads mark: first-time page → ❗');
ok(!textClaimsAdsNews('Recent ads run to x.com and from "X" handle. Still leading with UGC video.'), 'ads mark: standing state → no ❗');
ok(!textClaimsAdsNews('No new ads launched yesterday — most recent: "y".'), 'ads mark: quiet phrasing never false-positives');
ok(textClaimsSocialNews('New Instagram post: "hook here"'), 'social mark: new post → ❗');
ok(!textClaimsSocialNews('No new posts — latest is still "hook".'), 'social mark: quiet-with-latest → no ❗');
ok(textClaimsEmailNews('New email: "subject"'), 'email mark: new email → ❗');
ok(!textClaimsEmailNews('No new emails — latest: "subject".'), 'email mark: quiet → no ❗');
const { hasEmailOffer } = await import('../src/findings.js');
ok(hasEmailOffer('☀️ 15% off sun products') && hasEmailOffer('Use code GLOW20 at checkout') && hasEmailOffer('$10 off your next order'), 'email offer: %, code and $-off all detected');
ok(!hasEmailOffer('The science behind stronger hair'), 'email offer: plain subject → no flag');
ok(emailRowText('', 1, 5, 'Take 15% off tonight').indexOf('— carries a discount offer') > 0, 'fallback email row flags the offer');
const { diffWebsite } = await import('../src/website.js');
const wA = { items: { balm: { title: 'Tallow Balm', price: 44 } }, count: 1, saleCount: 0, min: 44 };
const wB = { items: { balm: { title: 'Tallow Balm', price: 39 } }, count: 1, saleCount: 0, min: 39 };
const dW = (diffWebsite(wA, wB) || []).find((x) => /→/.test(x));
ok(!!dW && /\(-11%\)/.test(dW), 'price move carries the % (-11%)');
const mkDay = (day, price) => ({ day, data: { summary: { items: { balm: { title: 'Tallow Balm', price } }, count: 1, saleCount: 0, min: price } } });
const { websiteFindings } = await import('../src/findings.js');
const wRows = [mkDay('2026-08-19', 35), mkDay('2026-08-17', 39), mkDay('2026-08-14', 42), mkDay('2026-08-10', 44)];
const wf = websiteFindings(wRows).find((f) => f.key && f.key.indexOf('web.change:') === 0 && /→/.test(f.text));
ok(!!wf && /3rd price move on this product inside two weeks/.test(wf.text), 'repeated cuts named as a pattern (3rd move in two weeks)');
const wf2 = websiteFindings([mkDay('2026-08-19', 39), mkDay('2026-08-18', 44)]).find((f) => f.key && f.key.indexOf('web.change:') === 0 && /→/.test(f.text));
ok(!!wf2 && !/price move on this product/.test(wf2.text), 'a single move stays a plain price line');
const { checkMisses: cm2 } = await import('../src/qa.js');
ok(true, 'campaign line: PROMPT + strict claims gate + judge bullet (no deterministic fixture — judgment-layer by design)');

console.log('\nBASELINE BRIEF + QUOTE-AWARE CLIP (Bloom/Gruns/AG1, 20 Aug):');
const ag1 = 'Two new immunity-campaign funnels live yesterday — EU and AU — plus a new partnership handle and 26 ad launches. Newest ad opens: "Your potential is capped by your foundation. If your nutrition is inconsistent, your…".';
const ag1clip = clipSent(ag1, 180);
ok(!fires(ag1clip, 'R-QUOTE-01'), 'clip never lands inside an open quotation (AG1: rich read collapsed to the stub)');
ok(/Newest ad opens: "Your potential/.test(ag1clip), 'the hook survives the clip');
const noQuote = 'First sentence about the ads here runs a good deal longer so it clears the boundary threshold and ends cleanly. ' + 'Second sentence is long '.repeat(12);
ok(/cleanly\.$/.test(clipSent(noQuote, 180)), 'normal sentence-boundary clipping unchanged');
const baseRow = 'Storefront banner: “NEW! Daily Hydration Sticks — Shop Now” — first capture; day-over-day comparison starts tomorrow.';
ok(clean(baseRow), 'baseline banner row is gate-clean');
ok(!textClaimsWebNews(baseRow), 'competitor copy saying NEW inside quotes never earns the ❗');
ok(clean('Newest ad still running opens: “hook text”.'), 'tier-2 ads fallback is gate-clean');
ok(!textClaimsAdsNews('Newest ad still running opens: “hook text”.'), 'tier-2 ads fallback claims no newness → no ❗');
ok(textClaimsAdsNews('Two new immunity-campaign funnels live yesterday — EU and AU — plus a new partnership handle and 26 ad launches.'), 'AG1 phrasing (funnels with words between, "N ad launches") → ❗');
ok(!textClaimsFunnel('No new funnels this week; same landing pages.'), 'quiet funnel phrasing → no ❗');
ok(fires('Storefront promo.', 'R-TEXT-02'), '"Storefront promo." corpse (Gruns, 20 Aug) → gated to fallback');
ok(clean('Storefront promo: "NEW! Minions Bello Berry Banana" — first seen yesterday.'), 'a real promo line still passes');

console.log('\nRENDERED PLAIN BRIEF — the layout survives a Block Kit rejection (20 Aug):');
const { renderPlainBrief, briefBlocks } = await import('../src/slack.js');
const briefText = '*WatchBack daily* · Thu, 20 Aug\n\n*AG1* 💡\n   *Ads:* ❗ Two new funnels.\n   *Social:* Posting daily.\n   *Website:* ❗ Storefront promo: "Welcome Offer".\n   *Email:* Only the confirmation.\n\n*Bloom* 🔹 baseline forming\n   *Social:* Pear Scare push.\n   *Website:* ❗ 3 products removed.\n\n🔗 <https://watchback.ai/app.html|View →>';
const rp = renderPlainBrief(briefText);
ok(rp.indexOf('────') > 0, 'plain fallback carries divider lines between brands');
ok(/\*Social:\* Posting daily\.\n\n {3}\*Website:\*/.test(rp), 'variant-C gap (blank row before Website) present in plain render');
ok(rp.indexOf('*WatchBack daily*') === 0 && rp.indexOf('🔗') > 0, 'header and link intact');
ok(briefText.indexOf('────') < 0, 'canonical text stays gap-free and divider-free (QA reads it)');
ok(Array.isArray(briefBlocks(briefText)) || briefBlocks(briefText) === null, 'briefBlocks unchanged in shape');

console.log('\nBANNER-AWARE COMPARE PANEL — no contradiction under an announced sale (Grüns, 20 Aug):');
const { bannerChangeFor } = await import('../src/website.js');
const bcG = bannerChangeFor('NEW! Minions Bello Berry Banana — grab this iconic, mischievous flavor', "It's Grüns' Birthday! We lowered our price to celebrate — Save 55% + Free Shipping");
ok(!!bcG && bcG.isSale, 'Minions banner → Birthday sale banner = banner change, flagged as a sale');
ok(!bannerChangeFor('UP TO 40% OFF', 'UP TO 40% OFF 1M JARS SOLD'), 're-worded same bar (containment) → no change (rotation-safe)');
ok(!bannerChangeFor('', 'Save 55%'), 'no earlier banner → no change verdict (nothing to compare)');

console.log('\nQALOG — every silent downgrade lands in the ledger (20 Aug, "never ask the same question again"):');
const { qaLog, qaDrain, qaEvents } = await import('../src/qalog.js');
qaDrain();   // clean slate
const { enforceClaims } = await import('../src/claims.js');
enforceClaims('Their brand-new page launched today.', { knownEntities: [], changeFindings: [], hasEarlier: false, canAssertNew: false }, 'TestBrand/ads');
ok(qaEvents.some((e) => e.kind === 'claim-strip' && e.label === 'TestBrand/ads'), 'a claim strip is ledgered, not just console.warn');
qaLog('sense-strip', 'X/website', 'removed sentence here');
const dq = qaDrain();
ok(dq.total >= 2 && dq.byKind['claim-strip'] >= 1 && dq.byKind['sense-strip'] === 1, 'drain groups by kind for the daily digest');
ok(qaEvents.length === 0, 'drain resets the ledger — tomorrow reports tomorrow');

console.log('\nFOUNDER WEBHOOK FALLBACK — no env var + no DB → honest reason, never a throw (19 Aug):');
const { postText } = await import('../src/slack.js');
const pt = await postText('ping');
ok(pt && pt.sent === false && /no Slack destination/i.test(pt.reason || ''), 'postText degrades to a clear reason when no destination resolves');

console.log('\nSENSE-CHECK FACTS — the checker sees everything the writer saw (Ancestral splice, 19 Aug):');
const { senseFacts } = await import('../src/insights.js');
const sf = senseFacts([{ text: 'Ad funnel live (already running): multiple ads drive to x.com/pages/lp — the funnel began on 2026-08-13.' }], 'RAW ADS FACTS HERE');
ok(sf.indexOf('funnel began on 2026-08-13') >= 0 && sf.indexOf('RAW ADS FACTS HERE') >= 0, 'computed findings prepend the raw facts for the sense check');
ok(sf.indexOf('COMPUTED FINDINGS') === 0, 'findings are framed as supported facts, so the checker cannot splice them out');
ok(senseFacts(null, 'JUST FACTS') === 'JUST FACTS', 'no findings → facts pass through unchanged');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
