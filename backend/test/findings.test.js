// FINDINGS ENGINE FIXTURES — the engine decides what is true, so it needs its own tests.
// Each case is a real failure, replayed as capture rows against the exported builders.
// Run: node test/findings.test.js
import { findingsBlock, adsFindings, websiteFindings, windowFindings } from '../src/findings.js';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
}
const row = (day, data) => ({ day, data });
const ad = (landing, page) => ({ landing, page });
const types = (list) => list.map((f) => f.type);

// findingsBlock must state the contract the whole design rests on.
const b = findingsBlock([{ type: 'state', text: 'Ads run to example.com.' }]);
console.log('\nFINDINGS CONTRACT:');
check('block names the findings as the ONLY material', /ONLY things established by the data/i.test(b));
check('block forbids adding claims', /may NOT add any\s*\n?claim/i.test(b));
check('block forbids invented newness verbs', /new, first, changed, dropped, launched or switched/i.test(b));
check('block tells the model to respect limits', /limit.*cannot establish/is.test(b));
check('empty findings produce no block', findingsBlock([]) === '' && findingsBlock(null) === '');

console.log('\nADS — NEW needs proof of absence; ENDED needs a complete capture:');

// Bonafide (4 Aug): every prior capture empty — the first real capture proves nothing new,
// not even ads whose Meta start date is fresh (we cannot tell a launch from our own baseline).
const bonafide = adsFindings([
  row('2026-08-04', { ads: [
    { id: 'b1', landing: 'https://bonafide.us/x', page: 'BonaFide', started: '2026-08-04' },
    { id: 'b2', landing: 'https://bonafide.us/y', page: 'BonaFide', started: '2026-08-03' },
  ] }),
  row('2026-08-03', { ads: [] }),
  row('2026-08-02', { ads: [] }),
], 50);
check('empty history → explicit nohistory limit', bonafide.some((f) => f.key === 'ads.nohistory'));
check('empty history → NOTHING may be typed new (launches included)', !types(bonafide).includes('new'));

// A genuinely new domain, with an earlier capture that actually held ads, IS a finding.
const genuineNew = adsFindings([
  row('2026-08-07', { ads: [ad('https://casaandbeyond.com/a', 'Casa & Beyond'), ad('https://shopcasa.io/b', 'Casa & Beyond'), ad('https://casaandbeyond.com/c', 'Casa & Beyond'), ad('https://casaandbeyond.com/d', 'Casa & Beyond')] }),
  row('2026-08-06', { ads: [ad('https://casaandbeyond.com/a', 'Casa & Beyond'), ad('https://casaandbeyond.com/c', 'Casa & Beyond'), ad('https://casaandbeyond.com/d', 'Casa & Beyond'), ad('https://casaandbeyond.com/e', 'Casa & Beyond')] }),
], 50);
check('a first-time domain with real earlier data is NEW', genuineNew.some((f) => f.key === 'ads.newDomain:shopcasa.io'));
check('a domain seen before is not', !genuineNew.some((f) => f.key === 'ads.newDomain:casaandbeyond.com'));

// Glov (1 Aug): capture at the collection cap — absence may never be asserted from it.
const cappedF = adsFindings([
  row('2026-08-02', { ads: Array.from({ length: 50 }, (_, i) => ad('https://glovbeauty.com/p' + i, 'Glov')) }),
  row('2026-08-01', { ads: Array.from({ length: 50 }, (_, i) => ad('https://glovbeauty.com/p' + i, i < 9 ? 'Persona ' + i : 'Glov')) }),
], 50);
check('capped capture → no absence findings at all', !types(cappedF).includes('absence'));
check('capped capture → the cap is stated as a limit', cappedF.some((f) => f.key === 'ads.sample' && /collection cap/i.test(f.text)));

// A FULL capture that lost pages may state the absence — worded as not-seen, never retired.
const fullGone = adsFindings([
  row('2026-08-07', { ads: Array.from({ length: 20 }, (_, i) => ad('https://theoodie.com/p' + i, 'The Oodie')) }),
  row('2026-08-06', { ads: Array.from({ length: 20 }, (_, i) => ad('https://theoodie.com/p' + i, i < 3 ? 'Oodie Persona' : 'The Oodie')) }),
], 50);
check('full capture may state pages gone', fullGone.some((f) => f.key === 'ads.pagesGone' && /not as retired/i.test(f.text)));

console.log('\nAD LAUNCHES (7 Aug) — first-seen id + fresh Meta start date = reportable news:');
// The founder’s "no ads updates" drought: domains/pages never change, so nothing was ever
// typed new. Launches are per-item proof and sampling-safe: id never captured before AND
// Meta start date on/after the last capture that held ads.
const launch = adsFindings([
  row('2026-08-07', { ads: [
    { id: 'a9', landing: 'https://glovbeauty.com/x', page: 'Glov Beauty', started: '2026-08-06', hasVideo: true, format: 'VIDEO', text: 'Scalp detox in 90 seconds — watch what comes out', link: 'https://facebook.com/ads/library/?id=a9' },
    { id: 'a5', landing: 'https://glovbeauty.com/y', page: 'Glov Beauty', started: '2026-08-03', format: 'IMAGE', text: 'Silk-free summer waves' },
    { id: 'a1', landing: 'https://glovbeauty.com/a', page: 'Glov Beauty', started: '2026-07-01' },
    { id: 'a0', landing: 'https://glovbeauty.com/b', page: 'Glov Beauty', started: '2026-06-15' },
  ] }),
  row('2026-08-06', { ads: [
    { id: 'a1', landing: 'https://glovbeauty.com/a', page: 'Glov Beauty', started: '2026-07-01' },
  ] }),
], 50);
const l9 = launch.find((f) => f.key === 'ads.launch:a9');
check('a first-seen id with a fresh start date is a LAUNCH finding', !!l9 && l9.type === 'new');
check('the launch carries date, format, page and the opening hook',
  !!l9 && l9.text.includes('2026-08-06') && l9.text.includes('video') && l9.text.includes('Glov Beauty') && l9.text.includes('Scalp detox'), l9 && l9.text);
check('lag-tail: started days ago but NEVER seen before is still a launch (capped windows surface late)',
  launch.some((f) => f.key === 'ads.launch:a5'));
check('an aggregate launches count is stated, dated from the oldest fresh ad',
  launch.some((f) => f.key === 'ads.launches' && /2 new ads launched since 2026-08-03/.test(f.text)));
check('an ad older than the 7-day window first sampled today is NOT a launch (date test)', !launch.some((f) => f.key === 'ads.launch:a0'));
check('an id captured before is NOT a launch (id test)', !launch.some((f) => f.key === 'ads.launch:a1'));

console.log('\nWEBSITE — the diff is ground truth; banners rotate:');

const feed = { onSale: 0, items: { h1: { title: 'The Oodie Original', price: 84 }, h2: { title: 'Sleep Tee', price: 49 } } };
const oneDay = websiteFindings([row('2026-08-07', { banner: '', summary: feed })]);
check('no earlier feed → nohistory limit, no change claims', oneDay.some((f) => f.key === 'web.nohistory') && !types(oneDay).includes('new') && !types(oneDay).includes('change'));

const unchanged = websiteFindings([
  row('2026-08-07', { banner: 'Summer Sale: 40% off sitewide', summary: feed }),
  row('2026-08-06', { banner: 'Summer Sale: 40% off sitewide', summary: feed }),
]);
check('identical feeds → explicit nochange state', unchanged.some((f) => f.key === 'web.nochange'));
const bannerF = unchanged.find((f) => f.key === 'web.banner');
// 10 Aug (supersedes the dated-banner pin): standing state carries no since-date in the
// TEXT — dating is clutter; the history date lives in evidence.since for the machinery.
check('unchanged sale banner: state, undated text, date kept in evidence',
  !!bannerF && bannerF.type === 'state' && /unchanged across recent captures/.test(bannerF.text)
  && !/since 2026/.test(bannerF.text) && bannerF.evidence.since === '2026-08-06',
  bannerF && bannerF.text);

// Glov (6 Aug): the announcement bar ROTATES — one captured slide is a sample of the bar.
const rotating = websiteFindings([
  row('2026-08-07', { banner: 'Free shipping over $50', summary: feed }),
  row('2026-08-06', { banner: 'Summer Sale: 40% off sitewide', summary: feed }),
  row('2026-08-05', { banner: 'Loved by 500,000+ customers', summary: feed }),
]);
check('multiple recent slides → rotation is stated', rotating.some((f) => f.key === 'web.rotation' && /ROTATES/.test(f.text)));

console.log('\nSOCIAL/EMAIL WINDOW — appearance only; a rolling window never proves absence:');

const posts = (d) => d && d.posts;
const noneToday = windowFindings([row('2026-08-07', { posts: [] })], 'Instagram', posts);
check('no content captured → honest limit, not "quiet"', noneToday.some((f) => f.key === 'Instagram.none' && /does not establish/i.test(f.text)));

const fresh = windowFindings([
  row('2026-08-07', { posts: [{ id: 'p2', text: 'Lash serum tutorial', link: 'https://x/2' }, { id: 'p1', text: 'Summer look', link: 'https://x/1' }] }),
  row('2026-08-06', { posts: [{ id: 'p1', text: 'Summer look', link: 'https://x/1' }] }),
], 'Instagram', posts);
check('a post that APPEARED is a new finding', fresh.some((f) => f.type === 'new' && f.text.includes('Lash serum tutorial')));
check('a window never emits absence findings', !types(fresh).includes('absence') && !types(noneToday).includes('absence'));

console.log('\nSTALE OFFERS + LANDING HEALTH — no live-since clutter; dead/redirected funnels caught:');

// Nolan (9 Aug): "live since 2026-08-08" was the newest AD's launch day read as the
// offer's age. The stale-offer finding must carry the staleness and nothing datable.
const bfAds = [{ id: 'bf1', text: 'Black Friday deal — 50% off everything', started: '2026-08-08', page: 'Nolan Interior', link: 'https://x/bf', landing: 'https://nolan.com/sale' }];
const staleF = adsFindings([
  row('2026-08-09', { ads: bfAds }),
  row('2026-08-08', { ads: [{ id: 'z9', text: 'old ad', started: '2026-06-01', landing: 'https://nolan.com/' }] }),
], 500);
const so = staleF.find((f) => f.key && String(f.key).startsWith('ads.staleOffer:'));
check('out-of-season offer is flagged', !!so && /out of season/.test(so.text));
check('stale-offer finding carries NO live-since date', !!so && !/live since|2026-08-08/.test(so.text));
const agg = staleF.find((f) => f.key === 'ads.launches');
check('launch aggregate quotes the opening hook', !!agg && agg.text.includes('Black Friday deal'));
check('launch aggregate names the landing domain', !!agg && agg.text.includes('nolan.com'));

// Landing health (9 Aug): get.thetallowedtruth.com served a 404 while ads ran to it, and
// try-derm.com silently redirected to the main site — both must become findings; a
// same-domain resolve and a network error must stay silent.
const landRow = row('2026-08-09', { ads: bfAds, landings: {
  'get.thetallowedtruth.com': { url: 'https://get.thetallowedtruth.com/', finalUrl: 'https://get.thetallowedtruth.com/', status: 404 },
  'try-derm.com': { url: 'https://try-derm.com/offer', finalUrl: 'https://thedrmlab.com/', status: 200 },
  'thedrmlab.com': { url: 'https://thedrmlab.com/x', finalUrl: 'https://www.thedrmlab.com/x', status: 200 },
  'flaky.com': { url: 'https://flaky.com/', error: 'timeout' },
} });
const lf = adsFindings([landRow], 500);
check('404 landing → DEAD-page finding', lf.some((f) => f.key === 'ads.landDown:get.thetallowedtruth.com' && /404/.test(f.text)));
check('cross-domain redirect → REDIRECT finding', lf.some((f) => String(f.key).startsWith('ads.landRedirect:try-derm.com') && f.text.includes('thedrmlab.com')));
check('same-domain resolve and network error stay silent', !lf.some((f) => String(f.key).includes('thedrmlab.com>') || String(f.key).includes('flaky')));

// Casa & Beyond (10 Aug): "50% off Clearance Sale ends in 14:27:10" — the ticking value
// must be stripped, the TIMER named as a tactic, the daily reset called evergreen, and
// no "unchanged since <date>" clause (live-since dating is clutter).
const timerRows = websiteFindings([
  row('2026-08-09', { banner: '50% OFF Clearance Sale ends in 14:27:10', summary: feed }),
  row('2026-08-08', { banner: '50% off Clearance Sale ends in 01:26:21', summary: feed }),
]);
const tb = timerRows.find((f) => f.key === 'web.banner');
check('countdown timer named as a tactic', !!tb && /COUNTDOWN TIMER/.test(tb.text));
check('daily reset called evergreen', !!tb && /resetting|evergreen/i.test(tb.text));
check('ticking value + since-date stripped', !!tb && !/14:27:10|since 2026/.test(tb.text));

// Same-brand redirect (casaandbeyond.com.au → casaandbeyond.com) is a geo/storefront
// hop, not a retired funnel; and redirect text must never carry querystrings/UTMs.
const geoRow = row('2026-08-09', { ads: bfAds, landings: {
  'casaandbeyond.com.au': { url: 'https://casaandbeyond.com.au/', finalUrl: 'https://casaandbeyond.com/', status: 200 },
  'go.seranovabeauty.com': { url: 'https://go.seranovabeauty.com/x', finalUrl: 'https://quiz.seranova.com/misw-offer?tw_source=a&lptoken=17388', status: 200 },
} });
const gf = adsFindings([geoRow], 500);
check('same-brand geo redirect stays silent', !gf.some((f) => String(f.key).includes('casaandbeyond')));
const sr = gf.find((f) => String(f.key).startsWith('ads.landRedirect:go.seranovabeauty.com'));
check('cross-brand redirect fires with clean path', !!sr && sr.text.includes('quiz.seranova.com/misw-offer'));
check('no querystrings/UTMs in redirect text', !!sr && !/[?]|lptoken|tw_source/.test(sr.text));

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
