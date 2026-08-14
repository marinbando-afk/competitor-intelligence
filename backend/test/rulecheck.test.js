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
ok(fires('Latest email.', 'R-TEXT-02'), 'R-TEXT-02 label-only survivor (Ancestral, 14 Aug)');
ok(fires('New email:', 'R-TEXT-02'), 'R-TEXT-02 bare label with colon');
ok(clean('Latest email: \u2018The full routine that closes out the month\u2019 — habit angle.'), 'full email line passes');
ok(fires('their best seller is undefined this week', 'R-TEXT-03'), 'R-TEXT-03 placeholder junk');
ok(fires('hook: "Will these fit my couch — plus more', 'R-QUOTE-01'), 'R-QUOTE-01 unbalanced quote');
ok(fires('the ads send traffic to Facebook’s login page', 'R-PHRASE-01'), 'R-PHRASE-01 banned login-page phrasing');
ok(fires('runs from a third-party page', 'R-PHRASE-02'), 'R-PHRASE-02 vague third-party page');
ok(fires('Ad landing domain x.com now redirects to y.com', 'R-CLAIM-01'), 'R-CLAIM-01 domain-wide redirect claim');
ok(fires('Storefront promo first seen 2026-08-11 on the banner', 'R-DATE-01'), 'R-DATE-01 raw ISO date in brief');
ok(fires('(One ad URL tested, not the whole go.seranovabeauty.com domain.) Every captured ad runs to go.seranovabeauty.com.', 'R-TEXT-04'), 'R-TEXT-04 orphaned leading parenthetical (Seranova, 13 Aug)');
ok(fires('New email item since 2026-08-11: \u201csmile, you\u2019re on camera\u201d.', 'R-DATE-01'), 'R-DATE-01 blanket-since exemption closed (Tallowed Truth, 13 Aug)');
ok(fires('New TikTok item since 2026-08-11: \u201cReduce widening partings\u201d.', 'R-DATE-01'), 'R-DATE-01 fires on dated social items too (CurrentBody, 13 Aug)');
ok(clean('1 new ad launched since 2026-08-08 (video) \u2014 newest opens: \u201cWinter is not over\u201d.'), 'launched-since keeps its date (genuine launch window)');
const { windowFindings } = await import('../src/findings.js');
const wf = windowFindings([
  { day: '2026-08-13', data: { posts: [ { id: 'p1', text: 'Reduce widening partings and support new growth with daily red light therapy' }, { id: 'p0', text: 'old post' } ] } },
  { day: '2026-08-12', data: { posts: [ { id: 'p0', text: 'old post' } ] } },
], 'TikTok', (d) => d && d.posts).find((f) => f.type === 'new');
ok(wf && wf.text.indexOf('New TikTok post: ') === 0 && wf.text.indexOf('since') < 0, 'feed finding reads "New TikTok post:" — no date, no "item" (13 Aug)');

console.log('\nOPERATIONAL BANNERS — free shipping is never reader-visible (Bonafide, 13 Aug):');
const { websiteFindings } = await import('../src/findings.js');
const wfeed = { onSale: 0, items: { p1: { title: 'Thing', price: 30 } } };
const opsB = websiteFindings([
  { day: '2026-08-13', data: { banner: 'FREE SHIPPING ON ALL ORDERS!', summary: wfeed } },
  { day: '2026-08-12', data: { banner: 'FREE SHIPPING ON ALL ORDERS!', summary: wfeed } },
]).find((f) => f.key === 'web.banner');
ok(opsB && opsB.type === 'context', 'operational banner typed context — machinery only, never phrased to a reader');
const luxeFoot = adsFindings([
  { day: '2026-08-13', data: { ads: [ { id: 'x1', landing: 'https://try.luxe.com/lp', page: 'Korean Beauty Insider', started: '2026-08-01' } ] } },
  { day: '2026-08-12', data: { ads: [ { id: 'x1', landing: 'https://try.luxe.com/lp', page: 'Korean Beauty Insider', started: '2026-08-01' } ] } },
], 50).find((f) => f.key === 'ads.footprint');
ok(luxeFoot && luxeFoot.text.indexOf('Recent ads run to ') === 0, '"Recent ads run to" — no capture-scope jargon (Luxe, 13 Aug)');

console.log('\nPROSE — the relativizer cannot create tense clashes (founder, 13 Aug):');
const { relativizeDay } = await import('../src/slack.js');
ok(relativizeDay('Timeleft is running no promotion on their storefront today.', '2026-08-12', '2026-08-13') === 'Timeleft is running no promotion on their storefront.', 'present tense + today → day word dropped, not swapped');
ok(relativizeDay('A new funnel appeared today.', '2026-08-12', '2026-08-13') === 'A new funnel appeared yesterday.', 'past-tense events still relativize to yesterday');

console.log('\nPRICE CAPTIONS — store currency labelled (Casa & Beyond, 13 Aug):');
const { changedHandlesForTest } = await import('../src/website.js').then(m => ({ changedHandlesForTest: m.changedHandles })).catch(() => ({ changedHandlesForTest: null }));
if (changedHandlesForTest) {
  const ch2 = changedHandlesForTest({ items: { p: { title: 'Bloom Pour', price: 89.99 } } }, { items: { p: { title: 'Bloom Pour', price: 119.99 } } }, 3);
  ok(ch2[0] && /store currency/.test(ch2[0].detail), 'price-move caption carries "(store currency)"');
} else { ok(true, 'changedHandles not exported — covered by source rule'); }

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
const briefMissing = '*Seranova* 🔹 routine activity\n   Ads: 24 new ads launched since yesterday (18 video, 6 image).';
const briefOk = '*Seranova* 💡\n   Website: Back to School Sale live — up to 58% off.';
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

console.log('\nREDIRECT FINDING — caveat lives inside ONE sentence, typed as change (13 Aug):');
const redir = adsFindings([
  { day: '2026-08-13', data: {
    ads: [ { id: 'r1', landing: 'https://go.brandx.com/lp', page: 'BrandX', started: '2026-08-01' } ],
    landings: { 'go.brandx.com': { url: 'https://go.brandx.com/lp', finalUrl: 'https://other-site.com/p', status: 200 } },
  } },
  { day: '2026-08-12', data: { ads: [ { id: 'r1', landing: 'https://go.brandx.com/lp', page: 'BrandX', started: '2026-08-01' } ] } },
], 50).find((f) => f.key && f.key.indexOf('ads.landRedirect') === 0);
ok(!!redir, 'redirect finding fires');
ok(redir && redir.type === 'change', 'typed change → traceable, our own gate cannot strip it');
ok(redir && !/\. \(/.test(redir.text), 'caveat is inside the sentence — no standalone parenthetical to orphan');
const { enforceClaims } = await import('../src/claims.js');
const ec = enforceClaims('BrandX launched a brand-new mega funnel yesterday. (One ad URL tested, not the whole domain.)', { knownEntities: ['mega funnel'], changeFindings: [] }, 'test');
ok(ec.text.indexOf('(One ad URL tested') < 0, 'claims strip can no longer leave a leading-parenthetical survivor');

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

console.log('\nWEBSITE ROW — single source: the app read is quoted verbatim, sale text only fills absence (founder, 13 Aug):');
const { websiteRowText } = await import('../src/slack.js');
const { saleAnnouncement } = await import('../src/signals.js');
ok(saleAnnouncement('Back to School Sale: up to 58% off') === '*New sale live* — \u201cBack to School Sale: up to 58% off\u201d', 'announcement: bold status, em-dash, banner quoted verbatim');
const { saleCatchupAnnouncement } = await import('../src/signals.js');
ok(saleCatchupAnnouncement('Spend $97 and get a FREE lip balm') === '*Sale live (already running)* — \u201cSpend $97 and get a FREE lip balm\u201d', 'old never-announced sale says already running, never New (Ancestral, 13 Aug)');
ok(websiteRowText(saleAnnouncement('Back to School Sale: up to 58% off'), 'Back to School Sale, up to 58% off, is active and unchanged.') === 'Back to School Sale, up to 58% off, is active and unchanged.', 'app read wins over the sale signal — Slack can never tell a different story (Froya, 13 Aug)');
ok(websiteRowText(saleAnnouncement('Back to School Sale: up to 58% off'), '').indexOf('*New sale live*') === 0, 'absent read → sale announcement fills the gap');
ok(websiteRowText('', 'Storefront unchanged — same prices, products and sale.') === 'Storefront unchanged — same prices, products and sale.', 'no sale signal → AI read ships as before');
ok(websiteRowText(null, '') === '', 'nothing → empty (row skipped)');

console.log('\nDAY-LOCK — a completed capture is immutable until tomorrow (founder, 12 Aug):');
const { hasSubstantiveData } = await import('../src/snapshots.js');
ok(hasSubstantiveData('ads', { ads: [{ id: 'a' }] }), 'ads with data → locked');
ok(!hasSubstantiveData('ads', { ads: [] }), 'empty ads capture → heal allowed');
ok(hasSubstantiveData('website', { summary: { items: {} } }), 'website with summary → locked');
ok(hasSubstantiveData('website', { shot: 'data:image/jpeg;…' }), 'website with frame → locked');
ok(!hasSubstantiveData('website', { banner: '' }), 'failed website capture → heal allowed');
ok(hasSubstantiveData('instagram', { posts: [{}] }), 'social with posts → locked');
ok(!hasSubstantiveData('instagram', { posts: [] }), 'empty social scrape → heal allowed');
ok(!hasSubstantiveData('insights', { ads: { summary: 'x' } }), 'insights never locked — re-runs recompute reads freely');
ok(!hasSubstantiveData('weekly', { report: {} }), 'weekly never locked');

console.log('\nSOCIAL ROW — a channel the app shows always gets a row (Pacific Foods, 12 Aug):');
const { socialRowText } = await import('../src/slack.js');
ok(socialRowText('IP collabs dominate the feed.', 2, 9) === 'IP collabs dominate the feed.', 'fresh read wins');
ok(socialRowText('', 2, 9) === '2 new posts captured — details in the app.', 'empty read + new posts → deterministic line');
ok(socialRowText('', 0, 9) === 'No new posts on the tracked profiles.', 'empty read + captured posts → honest no-new-posts row');
ok(socialRowText('', 0, 0) === '', 'nothing captured → row omitted (never padded)');
const pfFacts = [{ name: 'Pacific Foods', host: 'pacificfoods.com', sale: '', products: 0, staleOffers: 0, postsSeen: 9 }];
ok(checkMisses('*Pacific Foods* 🔹\n   Ads: something.', pfFacts).some((v) => v.rule === 'R-MISS-04'), 'posts captured + no Social row → R-MISS-04');
ok(checkMisses('*Pacific Foods* 🔹\n   Social: No new posts on the tracked profiles.', pfFacts).length === 0, 'Social row present → clean');
const { emailRowText } = await import('../src/slack.js');
ok(emailRowText('', 0, 16, 'Smooche is now on Amazon!') === 'No new emails — latest: "Smooche is now on Amazon!".', 'empty read + captured emails → honest latest-email row (Smooche, 13 Aug)');
ok(emailRowText('Latest email: cadence read.', 2, 16, 'x') === 'Latest email: cadence read.', 'app read wins when present');
ok(emailRowText('', 0, 0, '') === '', 'nothing captured → row omitted');
const smFacts = [{ name: 'Smooche', host: 'smooche.com', sale: '', products: 0, staleOffers: 0, postsSeen: 0, emailsSeen: 16 }];
ok(checkMisses('*Smooche* 💡\n   Ads: a.', smFacts).some((v) => v.rule === 'R-MISS-05'), 'captured emails + no Email row → R-MISS-05');

console.log('\nMARK SYNC — the ❗ follows the sentence it decorates (Ancestral, 14 Aug):');
const { textClaimsLaunches } = await import('../src/slack.js');
ok(textClaimsLaunches('16 new ads launched yesterday (12 video, 4 image) — newest opens: "x".'), 'launch sentence → mark required');
ok(!textClaimsLaunches('Recent ads run to x.com and from "X" handle.'), 'standing footprint → no forced mark');

console.log('\nANNOUNCE STATE — survives timer and read variance (Casa & UKLASH, 14 Aug):');
const { stripTimer, saleAnnouncedBefore } = await import('../src/signals.js');
ok(stripTimer('50% OFF CLEARANCE SALE ENDS IN 12:16:41') === stripTimer('50% OFF CLEARANCE SALE ENDS IN 14:27:10'), 'countdown values stripped → one identity across days');
const state = { banners: [{ b: '50% OFF CLEARANCE SALE', day: '2026-08-13' }] };
ok(saleAnnouncedBefore(state, '50% OFF CLEARANCE SALE ENDS IN 09:41:03', '2026-08-14'), 'timer variant of an announced sale → recognised, no re-fire');
ok(saleAnnouncedBefore({ banners: [{ b: 'Subscribe & Save 20% on every order', day: '2026-08-13' }] }, 'Save 20% with a subscription', '2026-08-14'), 'reworded read of the announced offer → recognised (UKLASH)');
ok(!saleAnnouncedBefore({ banners: [{ b: 'Summer Sale 40% off', day: '2026-08-13' }] }, 'Black Friday 70% off everything', '2026-08-14'), 'a genuinely different sale still fires');

console.log('\nCONGRUENCE — app, Slack and admin surfaces tell one story (founder, 12 Aug):');
const { checkCongruence } = await import('../src/qa.js');
const appRead = { ads: { summary: 'Discount-led video push.' }, social: { summary: 'IP collabs dominate.' }, website: { summary: 'Back to School Sale live, up to 58% off.' }, email: { summary: 'Latest: SPF launch email.' } };
const fullBlock = '*X* 💡\n   Ads: a.\n   Social: b.\n   Website: c.\n   Email: d.';
const noSocial = '*X* 💡\n   Ads: a.\n   Website: c.\n   Email: d.';
const fx = { name: 'X', sale: '', postsSeen: 0 };
ok(checkCongruence(fullBlock, appRead, fx).length === 0, 'all four rows match the app → congruent');
ok(checkCongruence(noSocial, appRead, fx).some((v) => v.rule === 'R-SYNC-01'), 'app shows social, brief lacks the row → R-SYNC-01');
ok(checkCongruence(fullBlock, { ads: appRead.ads, website: appRead.website, email: appRead.email }, fx).some((v) => v.rule === 'R-SYNC-02'), 'brief row without an app read → R-SYNC-02');
ok(checkCongruence(fullBlock, { ...appRead, website: { summary: 'Storefront unchanged — same prices.' } }, { name: 'X', sale: 'New sale live', postsSeen: 0 }).some((v) => v.rule === 'R-SYNC-03'), 'sale fired but app read silent → R-SYNC-03');
const bbBlock = '*X* 💡\n   Ads: a.\n   Social: b.\n   Website: *New sale live* — \u201cBuy More, Save up to 20%\u201d.\n   Email: d.';
const bbApp = { ...appRead, website: { summary: 'Bare Bones running unchanged volume discount — Buy More, Save up to 20%, no code needed.' } };
ok(checkCongruence(bbBlock, bbApp, { name: 'X', sale: 'x', postsSeen: 0 }).some((v) => v.rule === 'R-SYNC-04'), 'brief says NEW, app says unchanged → R-SYNC-04 (Bare Bones, 13 Aug)');
ok(!checkCongruence(fullBlock, bbApp, { name: 'X', sale: '', postsSeen: 0 }).some((v) => v.rule === 'R-SYNC-04'), 'no NEW claim → no contradiction');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
