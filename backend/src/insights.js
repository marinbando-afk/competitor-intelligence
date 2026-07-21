// AI insights — a per-channel, context-aware read on each competitor, generated
// daily by comparing TODAY's capture to the PREVIOUS one (so it surfaces what's
// new/changed, not the same static facts every day). One tight summary line +
// a few specific bullets per channel (ads, organic social, website, email).
//
//   GET /api/insights?host=theoodie.com&name=The%20Oodie  -> { insights: { ads, social, website, email } }
//
// Generated in the daily pre-warm and cached as an 'insights' snapshot. Needs
// ANTHROPIC_API_KEY (falls back to no insights if absent).

import Anthropic from '@anthropic-ai/sdk';
import { pool } from './db.js';
import { recentSnapshots, saveSnapshot, latestSnapshot, isPublicHost, allSnapshots, saveSnapshotDay, snapshotForDay } from './snapshots.js';
import { getEmails } from './email.js';
import { diffWebsite, siteShot, siteBannerFromShot } from './website.js';
import { getMyBrand } from './brand.js';
import { transcribeVideo } from './transcribe.js';
import { offerFacts, bannerFacts, todayLine, isSaleBanner } from './occasions.js';

// True when an Anthropic error means the account is out of credit (vs auth/rate/etc).
function isCreditError(e) { return /credit balance is too low/i.test(String((e && e.message) || e)); }

// Lightweight balance probe — a tiny Claude ping, cached ~5 min to bound cost.
// {ok:true} | {ok:false, empty, error}. Pass force=true to bypass the cache.
let _credit = { at: 0, val: null };
export async function creditStatus(force) {
  if (!force && _credit.val && Date.now() - _credit.at < 5 * 60 * 1000) return { ..._credit.val, cached: true };
  if (!process.env.ANTHROPIC_API_KEY) return { ok: false, empty: false, reason: 'no-key' };
  let val;
  try {
    await client().messages.create({ model: MODEL, max_tokens: 4, messages: [{ role: 'user', content: 'ping' }] });
    val = { ok: true };
  } catch (e) {
    val = { ok: false, empty: isCreditError(e), status: (e && e.status) || null, error: String((e && e.message) || e).slice(0, 200) };
  }
  _credit = { at: Date.now(), val };
  return val;
}

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5';           // the credit ping only (a balance probe needs the CHEAPEST model, not Opus — audit cost fix); creative/angle reads are in creativeRead
const INSIGHTS_MODEL = process.env.INSIGHTS_MODEL || 'claude-sonnet-4-6';  // daily per-channel summaries — Sonnet is plenty for summarizing, ~40% cheaper
let _client;
function client() { if (!_client) _client = new Anthropic(); return _client; }

const LAND_MODEL = process.env.LAND_MODEL || 'claude-haiku-4-5';   // landing-page format classifier (cheap)
const FETCH_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const _landCache = new Map();   // host -> { at, val:{format,note} } — analyzed landing-page formats, cached 24h
function htmlToText(html) {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}

const oneLine = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const dayOf = (s) => String(s || '').split('T')[0].split(' ')[0];

// ── compact, diff-friendly text for each channel ──────────────────────────────
function adHost(u) { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { return ''; } }
const INS_STOP = new Set(['the', 'and', 'for', 'shop', 'store', 'official', 'ltd', 'inc', 'llc', 'brand', 'online', 'cosmetics', 'beauty', 'skin', 'care', 'fashion', 'clothing', 'apparel', 'group', 'collective', 'australia']);
function brandToks(name) { return [...new Set(String(name || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !INS_STOP.has(w)))]; }
// DETERMINISTIC backstop: the model keeps parroting a TOTAL ad count from an incomplete sample
// ("10 of 19 ads", "19 active ads") however firmly the prompt forbids it (founder flagged it 3×),
// so strip/soften total-count-of-ads phrasing from any generated text. Deltas the founder allows
// ("3 new ads", "2 ads launched this week") are left intact.
function stripAdTotals(s) {
  if (!s) return s;
  return String(s)
    .replace(/\b\d+\s+of\s+(?:their\s+|its\s+)?\d+\s+ads\b/gi, 'many of their ads')          // "10 of 19 ads"
    .replace(/\b\d+\+?\s+(?:active|live|running|total|current)\s+ads\b/gi, 'their ads')       // "19 active ads"
    .replace(/\b(?:across|spanning|of)\s+(?:their\s+|its\s+)?\d+\+?\s+ads\b/gi, 'across their ads');   // "across 19 ads"
}
// Shared funnel analysis — pages + landing domains across ALL ads, flagging genuine
// third-party placements (publisher advertorials, media/affiliate partners) vs the
// brand's own pages/domains. EXPORTED so the chat uses the exact same view as this
// read — the app must never contradict itself.
export function funnelFacts(ads, brand) {
  ads = ads || [];
  const pageN = {}, domN = {};
  ads.forEach((a) => { const p = oneLine(a.page) || '?'; pageN[p] = (pageN[p] || 0) + 1; const dm = adHost(a.landing); if (dm) domN[dm] = (domN[dm] || 0) + 1; });
  const pages = Object.entries(pageN).sort((x, y) => y[1] - x[1]);
  const doms = Object.entries(domN).sort((x, y) => y[1] - x[1]);
  let toks = brandToks(brand);
  if (!toks.length && doms.length) { const sld = doms[0][0].split('.')[0]; if (sld.length >= 3) toks = [sld]; } // fallback: the dominant domain's root
  const own = (s) => { s = String(s || '').toLowerCase(); return !toks.length || toks.some((t) => s.indexOf(t) >= 0); };
  const isThird = (a) => (oneLine(a.page) && !own(a.page)) || (adHost(a.landing) && !own(adHost(a.landing)));
  // Page attribution taxonomy (founder, 21 Jul — use these EXACT terms):
  //   "Jenna with Smooche" → PARTNERSHIP ad (Meta's official branded-content pairing)
  //   "Jenna" alone advertising the brand → WHITELISTING ad (brand runs ads through a 3rd-party page)
  //   "Smooche" → BRANDED ad (the brand's own page)
  const clp = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const bcl = clp(brand);
  const kindOf = (a) => {
    // Partnership = an actual PAIRING, not just the brand's name in a byline field (the brand's
    // own ads often carry byline "Smooche" — still a BRANDED ad): an "X with <Brand>" byline/
    // page label, or a branded_content partner naming the brand while the ad runs from a
    // DIFFERENT page.
    const rawBy = (a.partner || '') + ' ' + (a.byline || '');
    const byC = clp(rawBy);
    const pg = oneLine(a.page);
    const isOwn = own(pg);
    if (bcl && byC && byC.indexOf(bcl) >= 0 && (/\swith\s/i.test(rawBy) || (!isOwn && clp(a.partner || '').indexOf(bcl) >= 0))) return 'partner';
    if (bcl && /\swith\s/i.test(pg) && clp(pg).indexOf(bcl) >= 0 && clp(pg) !== bcl) return 'partner';
    return isOwn ? 'own' : 'white';
  };
  const kindByPage = {};
  ads.forEach((a) => { const p = oneLine(a.page); if (!p) return; const k = kindOf(a); if (k !== 'own' && !kindByPage[p]) kindByPage[p] = k; });
  const partnerPages = pages.filter(([p]) => kindByPage[p] === 'partner');
  const whitePages = pages.filter(([p]) => kindByPage[p] === 'white');
  const thirdDoms = doms.filter(([dm]) => !own(dm));
  const ownDoms = doms.filter(([dm]) => own(dm));
  // We NEVER expose a total ad count or per-ad tallies to the model — Meta's Ad Library returns an
  // INCOMPLETE sample, so any "N ads" / "X of Y ads" it parrots is wrong-low (founder said this ~3×).
  // Order conveys prevalence; a qualitative share word replaces the count.
  const thirdRatio = ads.length ? ads.filter(isThird).length / ads.length : 0;
  const shareWord = thirdRatio >= 0.66 ? 'most' : thirdRatio >= 0.4 ? 'about half' : thirdRatio >= 0.15 ? 'a sizeable share' : 'a few';
  const text = [
    `FUNNEL FACTS (ground truth — do NOT contradict; and NEVER state a number/total of ads or "X of Y ads": our capture is an incomplete sample, so describe prevalence qualitatively — most / about half / a few — never a count):`,
    `  Ad pages (most-used first): ${pages.slice(0, 8).map(([p]) => `"${p}"`).join(', ')}.`,
    partnerPages.length ? `  >> PARTNERSHIP pages (Meta's official "X with ${brand}" branded-content pairing — call these PARTNERSHIP ads): ${partnerPages.map(([p]) => `"${p}"`).join(', ')}.` : '',
    whitePages.length ? `  >> WHITELISTED pages (3rd-party pages running the brand's ads with NO partnership label — call these WHITELISTING ads, a deliberate creator/persona whitelisting a.k.a. dark-posting tactic; ${shareWord} of their ad mix runs off the brand page): ${whitePages.map(([p]) => `"${p}"`).join(', ')}.` : '',
    (!partnerPages.length && !whitePages.length) ? `  All ads run from the brand's own page(s) — BRANDED ads only.` : '',
    `  Landing domains (most-used first): ${doms.slice(0, 10).map(([dm]) => dm).join(', ')}.`,
    thirdDoms.length ? `  >> THIRD-PARTY landing domains (off the brand's own sites): ${thirdDoms.map(([dm]) => dm).join(', ')} — they're sending traffic off-domain.` : `  All landings on the brand's own domain(s)${ownDoms.length > 1 ? ` (multiple regional sites: ${ownDoms.map(([dm]) => dm).join(', ')})` : ''}.`,
  ].filter(Boolean).join('\n');
  return { text, own, isThird, kindOf };
}
// The capture day a snapshot row is stamped with, as a Date — so timing facts are computed
// against the day the data was actually captured, not the moment a backfill happens to run.
// (Distinct from dayOf() above, which returns the day as a STRING.)
function capDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : new Date();
}

// `today` is passed ONLY for the current capture — the previous-capture block is context
// for comparison, so re-stating its offer timing there would just be noise.
function fmtAds(d, today) {
  if (!d || !d.ads || !d.ads.length) return 'No active ads.';
  const ads = d.ads;
  const ff = funnelFacts(ads, d.brand);
  // Sample ads — include every third-party ad, then fill with first-party, so both are visible.
  const third = ads.filter(ff.isThird), first = ads.filter((a) => !ff.isThird(a));
  const sample = third.slice(0, 6).concat(first.slice(0, Math.max(6, 16 - Math.min(third.length, 6))));
  const kindTag = (a) => { const k = ff.kindOf ? ff.kindOf(a) : 'own'; return k === 'partner' ? ' (PARTNERSHIP)' : k === 'white' ? ' (WHITELISTED)' : ''; };
  const lines = sample.map((a) => `- [${a.started || '?'}] ${a.hasVideo ? 'VIDEO' : 'IMAGE'} · page:"${a.page || '?'}"${kindTag(a)}${a.cta ? ` · cta:"${a.cta}"` : ''}${a.landing ? ` · lands:${adHost(a.landing)}${ff.own(adHost(a.landing)) ? '' : ' (3RD-PARTY)'}` : ''} :: ${oneLine(a.text).slice(0, 170)}`);
  return [`Active on ${(d.platforms || []).join('/') || '?'}; newest ad ${d.newest || '?'}. (NEVER state a total number of ads — this is an incomplete sample.)`, ff.text, 'SAMPLE ADS (a partial sample, NOT the full set — never count them):'].concat(lines).join('\n')
    + (today ? offerFacts(ads, today) : '');
}
function fmtPosts(posts, label, noEng) {
  if (!posts || !posts.length) return '';
  const out = [`${label}: ${posts.length} post(s).`];
  posts.slice(0, 8).forEach((p) => {
    // Engagement counts are cumulative lifetime totals. We show them only for the
    // latest capture, never the previous one, so the model can't subtract two
    // captures (which are different posts) and miscall it a "drop in reach."
    const eng = noEng ? '' : (p.views != null ? `${p.views} views` : (p.likes != null ? `${p.likes} likes` : ''));
    const com = noEng ? '' : (p.comments != null ? `, ${p.comments} comments` : '');
    out.push(`- [${dayOf(p.date)}] ${p.kind || 'Post'}${eng ? ` · ${eng}` : ''}${com} :: ${oneLine(p.text).slice(0, 150)}`);
  });
  return out.join('\n');
}
// Double opt-in / subscription-confirmation subjects (any language). These are NOT
// marketing campaigns — never analyse them or draw conclusions/suggestions from them.
const CONFIRM_RE = /(almost there|please confirm|confirm your (subscription|sign\s?-?up|email|newsletter|spot)|confirm (your )?subscription|verify your email|activate your subscription|bestätigen sie ihre anmeldung|anmeldung bestätigen|fast geschafft|abonnement bestätigen|confirmez votre (abonnement|inscription)|confirma tu suscripci)/i;
function isConfirmEmail(e) { return CONFIRM_RE.test(oneLine((e && e.subject) || '')); }
function fmtEmail(d) {
  if (!d || !d.emails || !d.emails.length) return 'No emails captured yet.';
  const sm = d.summary || {};
  const out = [`${d.emails.length} captured${sm.perWeek ? `, ~${sm.perWeek}/week` : ''}; offers seen: ${(sm.offers || []).join(', ') || 'none'}.`];
  d.emails.slice(0, 14).forEach((e) => out.push(`- [${dayOf(e.date)}] ${oneLine(e.subject).slice(0, 130)}${e.offer ? ` [offer: ${e.offer}]` : ''}`));
  return out.join('\n');
}
// Sanity-checked pricing view. Raw Shopify feeds include $0 giveaway entries, ~$1
// shipping-protection micro-SKUs and joke/PR listings at absurd prices (Liquid Death
// lists a $5.2M novelty) — a literal min–max like "price range $0–$5.2M" is meaningless.
// Use the 10th–90th percentile of real (>$1) prices as the TYPICAL range; name extremes
// separately as what they are.
function priceView(s) {
  const prices = Object.values(s.items || {}).map((i) => +i.price).filter((p) => p > 1).sort((a, b) => a - b);
  if (prices.length < 4) return { line: `price range ${s.min ?? '?'}–${s.max ?? '?'}`, note: '' };
  const q = (f) => prices[Math.max(0, Math.min(prices.length - 1, Math.round(f * (prices.length - 1))))];
  const lo = q(0.1), hi = q(0.9);
  const extremes = [];
  if (s.max != null && s.max > hi * 5) extremes.push(`novelty/PR listings priced up to ${s.max}`);
  if (s.min != null && s.min <= 1) extremes.push('free/giveaway or micro-fee entries near $0');
  return {
    line: `typical price range ${lo}–${hi}`,
    note: extremes.length ? ` (Catalogue also contains ${extremes.join(' and ')} — marketing stunts/utility SKUs, NOT real pricing; never quote them as the price range.)` : '',
  };
}
function fmtWeb(d, today, recentSaleBanner) {
  // Genuinely nothing captured — no product feed, no screenshot, no banner.
  if (!d || (!d.summary && !d.banner && !d.shot)) return 'No storefront data.';
  const s = d.summary;
  // A sale slide the announcement bar showed in a RECENT capture — so we can still name the
  // live sale ("Summer Sale") on a day the bar has rotated to a shipping slide instead.
  const saleName = (recentSaleBanner && isSaleBanner(recentSaleBanner)) ? String(recentSaleBanner).trim() : '';
  // Classify the captured banner so the read never mistakes a rotating "free shipping" slide
  // for a promo. Storefront announcement bars CYCLE several messages and we capture whichever
  // slide was showing, so the banner is the currently-shown slide — NOT proof of a change.
  const bannerLine = d.banner
    ? (isSaleBanner(d.banner)
        ? ` On-site announcement bar (one rotating slide) currently shows a SALE/PROMO: "${d.banner}".`
        : ` On-site announcement bar (one rotating slide) currently shows OPERATIONAL messaging (shipping/returns/positioning, NOT a promo): "${d.banner}". Do NOT call this a sale or a promo; do NOT say a sale started or ended because of it.`)
    : '';
  const bf = today ? bannerFacts(d.banner, today) : '';
  // The product FEED (Shopify products.json) can be missing while the storefront itself was
  // captured fine — some brands 404/redirect it (Brodo → www 404). Don't declare "nothing to
  // analyze" when we still have the live promo banner + a screenshot: read what we DO have.
  if (!s) {
    return 'Product catalogue not machine-readable for this store (their products feed is unavailable), so per-SKU counts/prices aren\'t captured — but the storefront WAS captured.' +
      (bannerLine || ' No promo banner is currently shown.') + bf +
      ' Analyze the on-site promo/positioning from the banner above; do NOT say there is no data or nothing to analyze.';
  }
  const pv = priceView(s);
  // Sale status leads every time, independent of whether anything changed. But describe the
  // sale QUALITATIVELY — by its OCCASION and headline discount — NEVER by a raw "N of M
  // products discounted" count. That count is meaningless intel (products.json includes
  // variants/utility SKUs, and a permanent compare-at anchor across most of the catalogue is
  // their standing pricing, not news) — founder rejected it, 18 Jul.
  let saleLine;
  if (s.onSale) {
    if (saleName) {
      saleLine = `ACTIVE SALE — "${saleName}" is running${!isSaleBanner(d.banner) ? ' (STILL live; the announcement bar has merely rotated to another slide today — NOT a sale ending)' : ''}. Name it by occasion + headline discount; do NOT cite a count of discounted products.`;
    } else {
      // A large share discounted with no sale banner is usually standing compare-at pricing,
      // not a limited event — say so honestly rather than crying "SALE".
      saleLine = 'Much of the catalogue carries a discount, but no sale event is named on-site — likely their standing compare-at pricing rather than a limited-time sale. Do NOT cite a count of discounted products; do NOT overstate it as a fresh sale.';
    }
  } else {
    saleLine = 'No discount on the catalogue — regular pricing.';
  }
  // A NEW PRODUCT LAUNCH is the headline website signal (founder, 18 Jul): the CHANGES block
  // below carries "N new products: …" from diffWebsite — lead with it when present.
  return saleLine + ' Typical ' + pv.line + '.' + pv.note + bannerLine + bf;
}

// ── Landing-page format analysis ───────────────────────────────────────────────
// Ad landing pages are FETCHED and read, then classified by FORMAT — so we report
// "pre.smooche.com is a listicle" from the page's actual content, never guessing
// "staging/pre-launch" from the subdomain name. Cached per host (24h).
// Classify a JS-rendered or bot-blocked page by RENDERING it (ScreenshotOne) and
// reading the screenshot with a vision model — handles funnels whose raw HTML is an
// empty shell (e.g. a React app) or that block plain fetches.
async function visionClassifyLanding(host, url, adText) {
  try {
    const shot = await siteShot(url);
    const m = shot && shot.match(/^data:(image\/[a-z]+);base64,(.+)$/);
    if (!m) return { format: 'unknown', note: 'page could not be rendered' };
    const system =
      'You are shown a SCREENSHOT of the landing page an ad sends people to (rendered in a real browser). Classify its FORMAT as exactly one of: ' +
      '"listicle", "advertorial", "third-party review", "sales page", "product page", "quiz/survey funnel", "home/category page", "other". ' +
      'An ADVERTORIAL or LISTICLE is a PRE-SELL page framed as EDITORIAL content — a personal story, a "why I switched" / "after decades of…" / "in [country] women do X" narrative, numbered reasons/tips, or a native-news article — that soft-sells before the buy; classify it as advertorial/listicle EVEN IF it also shows reviews, benefit tabs or a buy button. A plain PRODUCT PAGE is a direct product listing (price/variants/add-to-cart) with NO editorial story pre-sell. The AD COPY that drives traffic here is a STRONG hint to the funnel\'s intent. ' +
      'Add a note of <=12 words. Return ONLY minified JSON: {"format":"...","note":"..."}.';
    const resp = await client().messages.create({ model: process.env.LAND_VISION_MODEL || INSIGHTS_MODEL, max_tokens: 200, system, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } }, { type: 'text', text: 'host=' + host + '\nAD COPY THAT SENDS TRAFFIC HERE: ' + (adText || '(n/a)') }] }] });
    const raw = oneLine((resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''));
    let o = null; try { o = JSON.parse(raw); } catch (e) { const mm = raw.match(/\{[\s\S]*\}/); if (mm) { try { o = JSON.parse(mm[0]); } catch (_) { /* noop */ } } }
    o = o || {};
    return { format: String(o.format || 'other').slice(0, 40), note: String(o.note || '').slice(0, 90) };
  } catch (e) { return { format: 'unknown', note: 'page could not be rendered' }; }
}

// Persisted L2 for landing-format classifications (audit cost fix: the in-memory 24h cache dies
// with every deploy, so the same landing pages were re-fetched + re-classified again and again).
// 7-day TTL: funnels change slowly; a week-old format read is still right.
let _landTable = false;
async function landCacheHydrate(hosts) {
  if (!process.env.DATABASE_URL || !hosts.length) return;
  try {
    if (!_landTable) { await pool.query(`CREATE TABLE IF NOT EXISTS land_formats (host TEXT PRIMARY KEY, format TEXT, note TEXT, at TIMESTAMPTZ NOT NULL DEFAULT now())`); _landTable = true; }
    const r = await pool.query(`SELECT host, format, note FROM land_formats WHERE host = ANY($1) AND at > now() - interval '7 days'`, [hosts]);
    for (const row of r.rows) if (!_landCache.has(row.host)) _landCache.set(row.host, { at: Date.now(), val: { format: row.format, note: row.note || '' } });
  } catch (e) { /* memory cache still works */ }
}
function landCachePersist(host, val) {
  if (!process.env.DATABASE_URL || !val || val.format === 'unknown') return;   // don't pin a failed read for 7 days
  pool.query(`INSERT INTO land_formats(host, format, note, at) VALUES($1,$2,$3,now()) ON CONFLICT (host) DO UPDATE SET format=$2, note=$3, at=now()`, [host, val.format, val.note || '']).catch(() => {});
}
async function classifyUrls(items) {   // items: [{ host, url }]
  await landCacheHydrate([...new Set(items.map((it) => it.host))].filter((h) => !_landCache.has(h)));
  const out = new Map(), toFetch = [];
  for (const it of items) {
    const c = _landCache.get(it.host);
    if (c && Date.now() - c.at < 24 * 60 * 60 * 1000) out.set(it.host, c.val); else toFetch.push(it);
  }
  if (!toFetch.length) return out;
  const fetched = await Promise.all(toFetch.map(async (it) => {
    try {
      const r = await fetch(it.url, { redirect: 'follow', headers: { 'User-Agent': FETCH_UA, Accept: 'text/html,application/xhtml+xml' }, signal: AbortSignal.timeout(12000) });
      if (!r.ok) return { ...it, text: '' };
      const html = (await r.text()).slice(0, 250000);
      return { ...it, text: htmlToText(html).slice(0, 3500) };
    } catch (e) { return { ...it, text: '' }; }
  }));
  const rich = fetched.filter((f) => f.text && f.text.length >= 600);    // server-rendered → classify from text
  const thin = fetched.filter((f) => !(f.text && f.text.length >= 600));  // JS-shell / blocked → render + read the screenshot
  if (rich.length) {
    const list = rich.map((f, i) => `[${i + 1}] host=${f.host}\nAD COPY THAT SENDS TRAFFIC HERE: ${f.adText || '(n/a)'}\nPAGE CONTENT: ${f.text}`).join('\n\n=====\n\n');
    const system =
      'You are shown, for each ad LANDING PAGE, the AD COPY that drives traffic to it plus the page\'s readable text. Classify each page\'s FORMAT as exactly one of: ' +
      '"listicle", "advertorial", "third-party review", "sales page", "product page", "quiz/survey funnel", "home/category page", "app store", "other". ' +
      'An ADVERTORIAL or LISTICLE is a PRE-SELL page framed as EDITORIAL content — a personal story, a "why I switched" / "after decades of…" / "in [country] women do X" narrative, numbered reasons/tips, or a native-news article — that soft-sells before the buy; call it advertorial/listicle EVEN IF it also has reviews, benefits or a buy button. A plain PRODUCT PAGE is a direct product listing with NO editorial story pre-sell. Use the page content AND the ad copy (a strong hint to funnel intent); do NOT use the URL. ' +
      'Add a note of <=12 words on the angle/hook. Return ONLY minified JSON: {"v":[{"i":1,"format":"...","note":"..."}]}.';
    let arr = [];
    try {
      const resp = await client().messages.create({ model: LAND_MODEL, max_tokens: 700, system, messages: [{ role: 'user', content: list }] });
      const txt = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim().replace(/^```(?:json)?|```$/g, '').trim();
      const p = JSON.parse(txt); if (Array.isArray(p.v)) arr = p.v;
    } catch (e) { arr = []; }
    rich.forEach((f, idx) => {
      const hit = arr.find((x) => Number(x.i) === idx + 1);
      const val = hit ? { format: String(hit.format || 'other').slice(0, 40), note: String(hit.note || '').slice(0, 90) } : { format: 'unknown', note: '' };
      out.set(f.host, val); _landCache.set(f.host, { at: Date.now(), val }); landCachePersist(f.host, val);
    });
  }
  for (const f of thin.slice(0, 3)) {   // cap browser renders per run (vision cost)
    const val = await visionClassifyLanding(f.host, f.url, f.adText);
    out.set(f.host, val); _landCache.set(f.host, { at: Date.now(), val }); landCachePersist(f.host, val);
  }
  for (const f of thin.slice(3)) { const val = { format: 'unknown', note: 'not analyzed this run' }; out.set(f.host, val); _landCache.set(f.host, { at: Date.now(), val }); }
  return out;
}

// Build a context block of analyzed landing-page formats for the distinct hosts in this ad set.
async function landingFormats(ads) {
  if (!process.env.ANTHROPIC_API_KEY || !ads || !ads.length) return '';
  const repByHost = new Map();
  for (const a of ads) {
    const u = a && a.landing; if (!u || !/^https?:\/\//i.test(u)) continue;
    const h = adHost(u); if (!h || repByHost.has(h)) continue;
    repByHost.set(h, { url: u, adText: oneLine((a && a.text) || '').slice(0, 220) });   // ad copy reveals the funnel's intent
  }
  if (!repByHost.size) return '';
  const items = [...repByHost.entries()].slice(0, 6).map(([host, v]) => ({ host, url: v.url, adText: v.adText }));
  let results;
  try { results = await classifyUrls(items); } catch (e) { return ''; }
  const lines = items.map(({ host }) => {
    const r = results.get(host);
    return (r && r.format !== 'unknown') ? `- ${host} → ${r.format}${r.note ? ` (${r.note})` : ''}` : `- ${host} → not analyzable (couldn't fetch the page)`;
  });
  return '\n\nLANDING PAGE FORMATS — each page below was analyzed from its real content (fetched, or rendered in a browser when it is a JS app); use these exact formats and never infer format from the URL/subdomain:\n' + lines.join('\n');
}

// ── per-channel analyst guidance ──────────────────────────────────────────────
const GUIDE = {
  ads: 'their Meta/Facebook ads. If an OFFER TIMING FACTS block is present it is ground truth and TOP priority — a live ad is leaning on an OUT-OF-SEASON occasion; name the occasion and the numbers, and never soften it into generic "persistent discounting". BUT if MULTIPLE occasion pretexts are running at once or at similar discount depth (e.g. "Mother’s Day", "4th of July", "senior discount", a "hidden code they forgot to deactivate"), read it as ROTATING-PRETEXT / evergreen anchor-pricing — ONE deliberate tactic where the occasion is a costume and that % off is their real everyday price — not several separate stale sales, and don’t itemise how "stale" each one is. Offers seen in ads live IN THE ADS — describe them as "an ad runs X", never as their current or site-wide sale (the current sale comes ONLY from the website). And NEVER state a total or number of ads (our capture is an incomplete sample) — describe prevalence qualitatively (most / about half / a few), never "X of Y ads". Use the FUNNEL FACTS block as ground truth for pages and landing domains — NEVER claim there are no third-party pages or off-domain landings unless the facts confirm it; if any PARTNERSHIP, WHITELISTED page or third-party domain is listed (e.g. a news-publisher advertorial / native ad, an affiliate or media-partner funnel), SURFACE it as a notable tactic. PAGE ATTRIBUTION TAXONOMY — use these EXACT terms, never a vague "third-party page": an ad from the brand\'s own page is a BRANDED ad; a page/byline reading "X with <Brand>" is a PARTNERSHIP ad (Meta\'s official creator pairing); a separate page promoting the brand WITHOUT that pairing is a WHITELISTING ad (the brand advertising through a creator/persona page\'s identity, a.k.a. dark posting). A whitelisting or partnership mix is a deliberate, notable tactic — name which pages are which. LANDING-PAGE FORMAT: when a LANDING PAGE FORMATS block is provided, state each landing page\'s ACTUAL format from it (listicle, advertorial, third-party review, sales page, product page, quiz funnel, etc.) — those were produced by fetching and reading the real page. NEVER infer a landing page\'s format, purpose, or that it is a "staging"/"test"/"pre-launch"/"variant" page from its URL or subdomain name (e.g. do not assume "pre." means pre-launch); if a page is marked not-analyzable, say it wasn\'t read rather than guessing. If ads drive to a MARKETPLACE listing (Amazon, Walmart, Target, TikTok Shop, etc.) rather than the brand\'s own site, treat it as a DELIBERATE channel strategy, not a weakness — name why it is often smart (marketplace reviews/ratings as social proof, Prime trust and fast shipping, higher marketplace conversion, best-seller-rank/category dominance, Subscribe & Save retention) and what it signals; NEVER frame driving marketplace sales as "not driving sales" or a DTC shortfall — it IS driving sales, just through a chosen channel with different tradeoffs. Also surface, only if present: what is NEW vs the previous capture; the HOOKS and ANGLES in the copy; creative FORMATS (video vs image/carousel); whether they test multiple regional own-domains. Do not over-generalize beyond what the facts and sample support.',
  social: 'their organic social (Instagram / TikTok / Facebook). Engagement counts (views, likes, comments) are CUMULATIVE lifetime totals: they only ever climb, they grow with how long a post has been live, and a post does most of its growth in the first day or two. So a newer post almost always shows fewer than an older one, and that is normal — NOT a decline. NEVER frame a lower count — on a newer post, or versus a previous capture — as a drop, collapse, slump, dip, decay, or "reach/algorithm" problem, and never compute view/like deltas between captures (different posts are not comparable that way). What matters is STACKED engagement. Surface, only if present: which posts have accumulated the most total engagement; what is genuinely NEW since the previous capture (new posts / series); recurring HOOKS / ANGLES / themes; FORMATS (Reel / Carousel / Post); and any product or campaign focus.',
  website: 'their online storefront. A SALE means a DISCOUNT or a named sale EVENT — a % off, a $ off, a named occasion sale (Summer Sale, 4th of July, Black Friday, Anniversary), BOGO, clearance, a gift-with-purchase or a promo code. "Free shipping", "free returns", "new arrivals" and similar are EVERYDAY OPERATIONAL messaging, NOT a sale or a promo — never call them one, and never say a promo "went live" or "changed" because of them. ALWAYS lead with whether a genuine sale/promotion is ACTIVE right now (per the ACTIVE SALE / announcement-bar facts) — independent of whether it changed; an ONGOING, unchanged sale must still be named explicitly. When a sale is named by OCCASION, use that exact occasion name (e.g. "still running their Summer Sale, up to 70% off") — the occasion is valuable timing intel; never flatten it to a generic "an active sale". ⛔ NEVER cite a COUNT of discounted products ("66 of 90 products discounted") — that number is meaningless (variant/utility SKUs, and a permanent compare-at anchor is standing pricing, not news). Describe a sale ONLY by its occasion and headline discount. 🚀 A NEW PRODUCT LAUNCH is the single most important website signal — whenever the facts show products ADDED, LEAD with it and name the new product(s); a launch is high-value competitive intel worth surfacing above almost everything else on this channel. ⚠️ STOREFRONT ANNOUNCEMENT BARS ROTATE several slides (a sale slide, a free-shipping slide, a new-arrivals slide) and we capture whichever ONE was showing — so a banner that DIFFERS from last capture is almost always just the bar rotating to a different slide, NOT a promo change and NOT a sale starting or ending. NEVER report "sale ended / promo changed / free shipping replaced the sale" from the banner alone; a sale only genuinely started or ended if the ACTIVE SALE facts explicitly say "Sale started" / "Sale ended". Then surface what materially CHANGED: NEW PRODUCTS (lead with these), specific product price moves, products removed. Do NOT report a count of discounted products as a change. If nothing changed and no sale is active, say so in one line.',
  email: 'their email marketing. Surface: sending CADENCE; OFFER / discount patterns; recurring THEMES and angles; what is newest. Give a real read, not a list of subjects.',
};

// Trim to a word boundary with an ellipsis — never cut mid-word / mid-sentence.
function clip(s, n) {
  s = oneLine(s);
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  // Prefer ending on a COMPLETE thought: cut at the last sentence/clause boundary
  // (". ", "; ", " — ") when one exists past halfway — never trail off mid-phrase.
  const bounds = [cut.lastIndexOf('. '), cut.lastIndexOf('; '), cut.lastIndexOf(' — ')];
  const b = Math.max(...bounds);
  if (b > n * 0.35) return cut.slice(0, b + 1).replace(/[\s;,—-]+$/, '.').replace(/\.\.$/, '.');
  const sp = cut.lastIndexOf(' ');
  return (sp > n * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s.,;:!?'"\-—]+$/, '') + '…';
}
function parseOut(txt) {
  const raw = String(txt || '');
  let o = null;
  try { o = JSON.parse(raw); } catch (e) {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) { try { o = JSON.parse(m[0]); } catch (_) { /* noop */ } }
  }
  if (o && typeof o === 'object') {
    return {
      summary: stripAdTotals(clip(o.summary, 240)),
      bullets: Array.isArray(o.bullets) ? o.bullets.map((b) => stripAdTotals(clip(b, 230))).filter(Boolean).slice(0, 5) : [],
      apply: clip(o.apply, 260),
    };
  }
  // Malformed/truncated JSON (e.g. hit the token limit) — salvage the fields by regex
  // so a raw {"summary":...} blob is NEVER shown as the headline.
  if (raw.indexOf('"summary"') >= 0 || /^\s*\{/.test(raw)) {
    const grab = (k) => {
      const m = raw.match(new RegExp('"' + k + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"'));
      return m ? oneLine(m[1].replace(/\\"/g, '"').replace(/\\[rnt]/g, ' ')) : '';
    };
    let bm = raw.match(/"bullets"\s*:\s*\[([\s\S]*?)\]/);
    if (!bm) bm = raw.match(/"bullets"\s*:\s*\[([\s\S]*)/);
    const bullets = bm ? (bm[1].match(/"((?:[^"\\]|\\.)*)"/g) || []).map((s) => oneLine(s.slice(1, -1).replace(/\\"/g, '"'))).filter(Boolean).slice(0, 5) : [];
    const summary = grab('summary');
    if (summary || bullets.length) return { summary: clip(summary, 240), bullets: bullets.map((b) => clip(b, 230)), apply: clip(grab('apply'), 260) };
  }
  // Genuinely plain text — use it as the summary.
  return { summary: clip(raw, 240), bullets: [], apply: '' };
}

// Normalize a field that should be a short bullet LIST into a clean array — accepts an
// array, or a legacy prose string (split on sentence boundaries so old cached data still
// renders as bullets). Each bullet trimmed to a word boundary; capped at `max`.
function toBullets(v, max) {
  const arr = Array.isArray(v) ? v : (typeof v === 'string' && v.trim() ? v.split(/(?<=[.!?])\s+/) : []);
  return arr.map((s) => clip(s, 180)).filter(Boolean).slice(0, max || 3);
}

async function ask(channel, brand, todayBlock, prevBlock, me, today) {
  if (!todayBlock || !todayBlock.trim()) return null;
  let system =
    `You are WatchBack, a sharp eCommerce competitor-intelligence analyst. Analyze ${brand}'s ${channel} — ${GUIDE[channel]}\n\n` +
    // The model was never told the date, so an ad stamped [2026-05-26] was an inert string
    // and "Black Friday" could not be placed in time — Glov's out-of-season 90%-off BF ad
    // came out as "an aggressive 90%-off sale claim" (founder flagged it, 17 Jul 2026).
    `${todayLine(today || new Date())} Use it whenever timing matters; never assume any other date.\n` +
    `A LIVE SALE IS ALWAYS MATERIAL — never treat a sale, discount or offer as routine noise. Always name it: the occasion, the size, and whether it is still running.\n` +
    `AN OUT-OF-SEASON SALE IS A LEAD FINDING. When an OFFER TIMING FACTS or PROMO TIMING FACTS block reports an offer whose OCCASION is far out of season (e.g. a "Black Friday" sale running in July), that is among the most revealing things in the entire report and MUST appear in the summary or the FIRST bullet — never flattened into a generic "aggressive sale claim" or "persistent discounting". Name the occasion, how far out of season it is, and how long it has run. Read what it MEANS: the discount is effectively their permanent price, so their real margin tolerates it and the "sale" anchors a fake RRP. That block is computed from real dates — quote its numbers VERBATIM and never do your own date arithmetic.\n` +
    // The founder killed fake-timer callouts on sight: "this is common sense for ecom
    // brands". Evergreen urgency is table stakes in DTC — reporting it is noise, and it
    // dilutes the out-of-season finding, which is a checkable falsehood about WHEN.
    `NEVER report routine urgency devices as a finding: countdown timers, "Today only", "Ends tonight", "24/48 hours", "Last chance", "Limited time", "While stocks last" and the like are STANDARD eCommerce practice, expected of every DTC brand, and are NOT noteworthy even when the same ad has run for months. Do not call them fake, manufactured, misleading or a compliance risk, and never build a bullet around them. (An out-of-season OCCASION is different and still leads — it is a false claim about WHEN, not an urgency device.)\n\n` +
    `Use ONLY the DATA the user provides. Be specific: cite dates, numbers, offers, domains, handles, formats. ` +
    `Read every move as a DELIBERATE choice by a competent operator, with the BROADER CONTEXT in mind — give the strategic rationale and what it implies competitively, never a naive or dismissive take. A different channel, marketplace, funnel or price is a strategy with tradeoffs: explain the thinking behind it; do NOT frame an intentional choice as a failure, a gap, or "not doing X". ` +
    `SANITY-CHECK every number and claim before printing it: ask "would this look obviously wrong or absurd to this brand's own marketer?" Raw feeds contain $0 giveaway entries, ~$1 utility SKUs (shipping protection) and joke/PR listings at absurd prices — quote TYPICAL values and name extremes as the stunts they are; a meaningless literal like "price range $0–$5.2M" must never appear. If a figure doesn't make sense for this brand in this context, reinterpret it or leave it out. ` +
    `MATERIALITY FILTER — the deliberate-strategy rule applies only to MATERIAL moves, never to noise: ad counts fluctuate constantly as creatives rotate, so one or two ads more or less (36→35, 3→2), a single new/removed post, or any tiny delta is routine rotation — report it neutrally in one short clause (or omit it), and NEVER call it a pullback, retreat, shift, scale-down or deliberate anything. Strategic interpretation is reserved for material changes: a new funnel or landing-page type, a price or offer move, a sale starting/ending, a format shift across many creatives, a channel going dark or lighting up. ` +
    `Compare TODAY against the PREVIOUS capture and lead with what is NEW or CHANGED — do not just restate static facts or repeat an unchanging description. ` +
    // Write in ENGLISH: nothing here said so, and a stray non-English word once surfaced in a
    // brief with no foreign text anywhere in the source data ("честный" under Glov, 17 Jul).
    // Quoting the competitor's own copy verbatim is still fine — that IS the evidence.
    `If something isn't supported by the data, leave it out — never invent. Write for a busy marketer, and write in ENGLISH — the only non-English text allowed is a verbatim quote of the competitor's own copy. Keep every bullet and the apply SHORT and COMPLETE — a finished thought that never trails off mid-sentence; if a point won't fit concisely, drop detail rather than cut the ending.\n\n`;
  if (me && me.profile) {
    system +=
      `Also add an "apply" field. Act as ${me.name}'s DIRECTOR OF GROWTH: turn this channel's single most important takeaway into ONE realistic, specific move THEY could actually make — grounded in their ACTUAL products, prices and bundles below, and naming a real product, price point or bundle of theirs where you can. It should be doable without heavy resources; if it genuinely needs real effort or spend (new creative, a UGC budget, building a bundle, a price test, an email flow), name that cost briefly so it's clear you know what it takes. Be honest — if the tactic doesn't fit their catalogue or positioning, say so in one line instead of forcing it. Start with a verb, ≤ 34 words, finish the sentence.\n` +
      `ADVISING BRAND — ${me.name}${me.mainProduct ? ' (main product: ' + me.mainProduct + ')' : ''}: ${me.profile}${me.catalog ? '\nTHEIR CATALOGUE (real products, prices, bundles): ' + me.catalog : ''}\n\n` +
      `Return ONLY minified JSON, no markdown: {"summary":"<=16 words","bullets":["<one complete, self-contained point, ≤ 16 words — tight, no filler>", ...up to 3 — only the genuinely notable ones, fewer is better],"apply":"<the tailored growth move, one finished sentence>"}.`;
  } else {
    system += `Return ONLY minified JSON, no markdown: {"summary":"<one tight sentence (<=16 words): the single most important or most-new takeaway>","bullets":["<one complete, self-contained point, ≤ 16 words — tight, no filler>", ...]} with 0–3 bullets (only the genuinely notable ones — fewer is better). If nothing changed and nothing notable, return a 1-sentence summary and an empty bullets array.`;
  }
  const user = `=== TODAY ===\n${todayBlock}\n\n=== PREVIOUS CAPTURE ===\n${prevBlock && prevBlock.trim() ? prevBlock : '(no earlier capture to compare against yet)'}`;
  const resp = await client().messages.create({ model: INSIGHTS_MODEL, max_tokens: 1200, system, messages: [{ role: 'user', content: user }] });
  const txt = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return parseOut(txt);
}

// Generate insights for all channels of one brand and cache them as a snapshot.
export async function generateInsights(brand, host) {
  if (!process.env.ANTHROPIC_API_KEY || !host) return null;
  brand = brand || host;
  const out = {};
  // The insights snapshot is a SINGLE shared row per host (snapshots key on host+channel,
  // no uid) read by every co-watching account AND by anonymous demo/report visitors — so
  // it MUST be tenant-neutral. Always tailor the "apply"/counter-op to the DEFAULT
  // illustrative brand, NEVER a real customer's (that would leak one client's brand name,
  // catalogue and prices to every other viewer). Per-viewer "apply to you" is done live in
  // /api/angle, which is returned to the caller and never cached to a shared snapshot.
  const me = await getMyBrand(null);

  try {
    const r = await recentSnapshots(host, 'ads', 2);
    if (r[0] && r[0].data) {
      const lf = await landingFormats(r[0].data.ads || []);   // FETCH + read each landing page, classify its format
      const day = capDate(r[0].day);
      out.ads = await ask('ads', brand, fmtAds(r[0].data, day) + lf, r[1] && r[1].data ? fmtAds(r[1].data) : '', me, day);
    }
  } catch (e) { /* skip */ }

  try {
    const today = [], prev = [];
    let capDay = null;
    for (const [pf, lab] of [['instagram', 'Instagram'], ['tiktok', 'TikTok'], ['facebook', 'Facebook']]) {
      const r = await recentSnapshots(host, pf, 2);
      if (r[0] && r[0].data && r[0].data.posts && r[0].data.posts.length) { today.push(fmtPosts(r[0].data.posts, lab + ' @' + (r[0].data.handle || ''))); capDay = capDay || capDate(r[0].day); }
      if (r[1] && r[1].data && r[1].data.posts && r[1].data.posts.length) prev.push(fmtPosts(r[1].data.posts, lab, true));
    }
    if (today.length) out.social = await ask('social', brand, today.join('\n\n'), prev.join('\n\n'), me, capDay);
  } catch (e) { /* skip */ }

  try {
    const r = await recentSnapshots(host, 'website', 8);   // deeper history to find the last SALE slide
    if (r[0] && r[0].data) {
      const changes = (r[1] && r[1].data) ? diffWebsite(r[1].data.summary, r[0].data.summary) : null;
      const day = capDate(r[0].day);
      // Most recent announcement-bar slide that was an actual sale (today's or an earlier day's),
      // so the read can name a live sale even when today's captured slide is a shipping one.
      const recentSaleBanner = (r.find((x) => x.data && isSaleBanner(x.data.banner)) || {}).data?.banner || '';
      const todayBlock = fmtWeb(r[0].data, day, recentSaleBanner) + '\nCHANGES vs previous capture: ' + (changes ? (changes.join('; ') || 'none detected') : 'n/a (first capture)');
      out.website = await ask('website', brand, todayBlock, r[1] && r[1].data ? fmtWeb(r[1].data) : '', me, day);
    }
  } catch (e) { /* skip */ }

  try {
    const em = await getEmails(host, brand);
    const all = (em && em.emails) || [];
    const real = all.filter((e) => !isConfirmEmail(e));   // ignore opt-in confirmations
    if (all.length && !real.length) {
      // Only a sign-up confirmation so far — nothing to analyse. Don't invent cadence/offers/suggestions.
      out.email = { summary: 'Only the sign-up confirmation captured so far — their first newsletter lands with their next campaign, usually within a day or two.', bullets: [] };
    } else if (real.length) {
      out.email = await ask('email', brand, fmtEmail({ emails: real, summary: em.summary }), '', me);
    }
  } catch (e) { /* skip */ }

  // Top-of-report brief: THREAT ASSESSMENT + RECOMMENDED COUNTER-OP, synthesized
  // across all channels — user-added competitors get the same dossier treatment as
  // the curated demos.
  try {
    const b = await makeBrief(brand, out, me, new Date());
    if (b) out.brief = b;
    else console.warn('brief ' + host + ': makeBrief returned nothing — report saved without a THREAT ASSESSMENT');
  } catch (e) {
    // Was silent. A transient failure here leaves the whole day's report with channels but
    // no summary, and getInsights only regenerates when there are ZERO channels — so it
    // never healed itself and nobody knew (Ancestral, 17 Jul). getInsights now repairs it.
    console.warn('brief ' + host + ':', e.message);
  }

  // Drop empty channels.
  Object.keys(out).forEach((k) => { if (!out[k]) delete out[k]; });
  if (Object.keys(out).length) { out.generatedAt = new Date().toISOString(); await saveSnapshot(host, 'insights', out); }
  return out;
}

// One-time historical fix (host-scoped). The promo banner used to be read from a plain
// HTML fetch (no JS), so a banner sitting in the page code behind a countdown could be
// reported a day BEFORE it was visibly shown. This walks every stored day, re-reads that
// day's banner from that day's SCREENSHOT (the rendered visual), then regenerates that
// day's website read against the day before — so a sale switch lands on the day it
// VISIBLY changed, matching the before/after image. Touches only the named host's
// website + insights channels; every other brand is untouched.
export async function backfillWebsiteReads(host, brand) {
  if (!process.env.ANTHROPIC_API_KEY || !host) return { days: 0, regenerated: 0 };
  brand = brand || host;
  const rows = await allSnapshots(host, 'website');   // oldest → newest
  // 1) Re-read each day's banner from its stored screenshot and persist it to that day.
  for (const r of rows) {
    const d = r.data;
    if (!d || !d.shot) continue;
    try {
      const b = await siteBannerFromShot(d.shot, '');   // trust the rendered visual
      d.banner = (b || '').trim() || null;
      await saveSnapshotDay(host, 'website', r.day, d);
    } catch (e) { /* keep the stored banner on error */ }
  }
  // 2) Regenerate each day's website read against the day before (tenant-neutral).
  let regenerated = 0;
  for (let i = 0; i < rows.length; i++) {
    const today = rows[i].data, prev = i > 0 ? rows[i - 1].data : null;
    if (!today || !today.summary) continue;
    try {
      const changes = prev ? diffWebsite(prev.summary, today.summary) : null;
      const day = capDate(rows[i].day);
      const todayBlock = fmtWeb(today, day) + '\nCHANGES vs previous capture: ' + (changes ? (changes.join('; ') || 'none detected') : 'n/a (first capture)');
      const read = await ask('website', brand, todayBlock, prev ? fmtWeb(prev) : '', null, day);
      if (!read) continue;
      const ins = (await snapshotForDay(host, rows[i].day)).insights || {};
      ins.website = read;
      await saveSnapshotDay(host, 'insights', rows[i].day, ins);
      regenerated++;
    } catch (e) { /* skip the day on error */ }
  }
  return { days: rows.length, regenerated };
}

// Cross-channel synthesis for the report header. Same discipline as the channel
// reads: grounded, sanity-checked, strategic — never naive or dismissive.
async function makeBrief(brand, out, me, today) {
  const parts = [];
  for (const [k, label] of [['ads', 'ADS'], ['social', 'SOCIAL'], ['website', 'WEBSITE'], ['email', 'EMAIL']]) {
    const c = out[k];
    if (!c || !(c.summary || (c.bullets && c.bullets.length))) continue;
    parts.push(`${label}: ${c.summary || ''}${(c.bullets && c.bullets.length) ? ' — ' + c.bullets.join(' · ') : ''}`);
  }
  if (!parts.length) return null;
  const system =
    `You are WatchBack, a sharp eCommerce competitor-intelligence analyst. From the per-channel reads below, write the top-of-report brief on "${brand}", in ENGLISH (the only non-English text allowed is a verbatim quote of the competitor's own copy). ` +
    `${todayLine(today || new Date())} ` +
    `Same discipline as always: use only what the reads support, sanity-check every number, and read deliberate moves as strategy with a rationale — never a naive or dismissive take. ` +
    `Ignore noise: tiny count fluctuations (an ad or two, a single post) are routine rotation — never present them as strategic moves.\n` +
    // A stale sale is the highest-signal thing in the whole dossier and it was arriving as a
    // vague "persistent 90%-off ad claims" bullet — name the occasion or it reads as nothing.
    // Founder rule (20 Jul): the "current sale" is ONLY what's live on the website. Ads promote
    // all sorts of rotating offers (Mother's Day, senior discount…) that are NOT the brand's sale.
    `⚠️ SOURCE OF THE "CURRENT SALE": the brand's current / relevant SALE is ONLY whatever is live on their WEBSITE — the storefront banner or a catalogue-wide discount from the WEBSITE read (e.g. a "4th of July Sale" on the storefront). An offer promoted inside an AD (a "Mother's Day 64% off" ad, a "senior discount" ad) is NOT their current sale — it is ad-creative content. Offers seen in ADS may be described in the ads read as offers their ADS promote, but NEVER present an ad's offer as the brand's current/relevant sale, never let it lead as "their sale", and never let it override or stand in for the website sale. ` +
    `A live SALE (on the website) is always material and must be named, never omitted as routine. If a read reports an offer that is OUT OF SEASON (an occasion that passed months ago — e.g. a "Black Friday" sale still running in July), name it and what it means: the discount is effectively their real price, anchored against a fake RRP — never soften it into generic "persistent discounting". ` +
    // Seranova runs Mother's Day + 4th of July + "senior discount" + a "hidden code" ALL at once,
    // every one ~64% off. That's not several forgotten sales — it's one deliberate always-on tactic.
    `⚠️ CRUCIAL — recognise ROTATING-PRETEXT / EVERGREEN discounting: when SEVERAL different occasion or "reason to discount" offers run AT THE SAME TIME, or land at a similar discount depth (e.g. a "Mother's Day 64% off" ad AND a "4th of July 58% off" AND a "senior discount" AND a "hidden code they forgot to deactivate", all live together), that is ONE deliberate anchor-pricing tactic, NOT several stale sales. Report it as a SINGLE finding — the occasion is a rotating PRETEXT and that ~% off is their PERMANENT real price — and cite the rotating pretexts as the evidence. Do NOT lead with, itemise, or compute how many weeks "stale" each individual occasion is, and NEVER imply they forgot to switch one off: the rotation is intentional. ` +
    `But NEVER report routine urgency devices — countdown timers, "Today only", "Ends tonight", "Last chance", "Limited time" — as a finding: they are standard eCommerce practice, not news, however long the ad has run.\n` +
    // Founder repeated this 3×: ad offers ≠ site sale, and never a total ad count.
    `⛔ AD-vs-SITE SALE (hard rule): an offer you see only in AD COPY (e.g. a "Mother's Day 64%-off code") is NOT the brand's sale. Do NOT put it in the verdict as a current/site-wide sale, and do NOT compute how many weeks "stale" its occasion is. The verdict's only "sale" is a LIVE WEBSITE sale from the website read. If an ad's offer must be referenced at all, write it explicitly as "in an ad" — never as a plain site-wide offer.\n` +
    `⛔ NEVER state a number or total of ads ("19 ads", "10 of 19 ads", "10 active ads") — our capture is an incomplete sample. Describe prevalence qualitatively (most / about half / a few). Counts of NEW ads launched in a period are fine; totals are not.\n` +
    `Return ONLY minified JSON, no markdown, as SHORT, SCANNABLE BULLET POINTS (not paragraphs): {"verdict":["<THREAT ASSESSMENT — 2 to 3 bullets, each ONE tight point ≤ 13 words, telegraphic: LEAD with the key fact, cut filler/connective words. The most important strategic reads right now, concrete and specific>", ...],"move":["<RECOMMENDED COUNTER-OP — 2 to 3 bullets, each ONE concrete ${me && me.profile ? `move for ${me.name} grounded in their profile below` : 'move for a brand competing with them'}, ≤ 13 words, start with a verb, cut filler>", ...]}` +
    (me && me.profile ? `\nADVISING BRAND — ${me.name}${me.mainProduct ? ' (main product: ' + me.mainProduct + ')' : ''}: ${me.profile}` : '');
  const resp = await client().messages.create({ model: INSIGHTS_MODEL, max_tokens: 500, system, messages: [{ role: 'user', content: parts.join('\n') }] });
  const txt = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  // Robust parse: try clean JSON, then salvage the first {...} object if the model wrapped
  // it in any preamble/markdown — otherwise a stray word silently drops the whole brief
  // (which is why the Threat assessment / counter-op sometimes vanished while channels stayed).
  let j = null;
  try { j = JSON.parse(txt.replace(/^```json?\s*/i, '').replace(/\s*```$/, '')); }
  catch (e) { const m = txt.match(/\{[\s\S]*\}/); if (m) { try { j = JSON.parse(m[0]); } catch (_) { /* give up */ } } }
  const verdict = toBullets(j && j.verdict, 3).map(stripAdTotals);
  if (verdict.length) return { verdict, move: toBullets(j && j.move, 3).map(stripAdTotals) };
  return null;
}

// A one-line marketing ANGLE for a single ad/post, generated on demand (cheap,
// cached) when the user opens its preview.
const _angleCache = new Map();
const ANGLE_CACHE_MAX = 3000;   // bound the in-memory creative-read cache (warm now fills it for every ad/post)
function _angleSet(key, val) { _angleCache.set(key, val); if (_angleCache.size > ANGLE_CACHE_MAX) _angleCache.delete(_angleCache.keys().next().value); }
const UA_IMG = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
// Fetch a creative image as a base64 block for the multimodal model (skips non-images / oversized).
// Detect the true image type from magic bytes (CDNs often mislabel webp as jpeg,
// which the vision API then rejects).
function detectMedia(b) {
  if (!b || b.length < 12) return null;
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}
async function fetchImageB64(url) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA_IMG, Accept: 'image/*' } });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 600 || buf.length > 4.5 * 1024 * 1024) return null;
    const media = detectMedia(buf);   // trust the bytes, not the Content-Type header
    if (!media) return null;
    return { type: 'base64', media_type: media, data: buf.toString('base64') };
  } catch (e) { return null; }
}

// Vision-powered analysis of a single ad/post — sees the actual CREATIVE (image,
// or a video ad's cover frame) plus the copy → angle, hook, creative read, apply.
export async function quickAngle(text, kind, image, video, uid) {
  const t = oneLine(text).slice(0, 1400);
  if (!process.env.ANTHROPIC_API_KEY) return { angle: '', hook: '', creative: '', apply: '' };
  const me = await getMyBrand(uid);
  const img = image ? await fetchImageB64(image) : null;
  const script = video ? await transcribeVideo(video) : '';   // spoken hook of a video ad (needs OPENAI_API_KEY)
  // Key MUST include the viewer's uid: the "apply" field is tailored to THIS account's own
  // brand/catalogue, so two accounts that happen to share a brand host must not read each
  // other's cached result. (angle/hook/creative are creative-specific, but apply is not.)
  const key = (kind || 'ad') + '|' + (uid || '') + '|' + ((me && me.host) || '') + '|' + (img ? 'V' : 'T') + (script ? 'S' : '') + '|' + String(image || '').slice(0, 70) + '|' + String(video || '').slice(0, 50) + '|' + t.slice(0, 100);
  if (_angleCache.has(key)) return _angleCache.get(key);
  const what = kind === 'post' ? 'organic social post' : 'ad';
  const visual = (img
    ? (kind === 'post' ? 'You are shown the post CREATIVE (image).' : 'You are shown the ad CREATIVE — for a video ad this is its cover frame.')
    : 'No creative image is available — analyze from the copy only and leave "creative" brief.')
    + (script ? ' A transcription of the video\'s SPOKEN audio is also provided — base the HOOK on the actual opening line(s) of that script.' : '');
  const applyField = (me && me.profile)
    ? `,"apply":"<as ${me.name}'s director of growth: ONE realistic, doable move using the SAME approach, grounded in their real products/prices/bundles and naming one where you can; if it needs real spend/effort, name it; if it doesn't fit, say so briefly. Start with a verb, <=32 words>"`
    : `,"apply":""`;
  const brandLine = (me && me.profile) ? `\nADVISING BRAND — ${me.name}${me.mainProduct ? ' (main product: ' + me.mainProduct + ')' : ''}: ${me.profile}${me.catalog ? '\nTHEIR CATALOGUE: ' + me.catalog : ''}` : '';
  // For a video ad the spoken opening IS the hook — lead with it when we have the script.
  const hookField = script
    ? `"hook":"<the opening hook — LEAD with the first spoken line(s) from the VIDEO SCRIPT, then the opening visual/on-screen text, <=22 words>",`
    : `"hook":"<what grabs attention first — the visual + any headline/on-screen text, <=16 words>",`;
  const system =
    `You are a performance-marketing strategist analyzing a competitor's ${what}. ${visual} ` +
    `Be specific and concrete — describe what you actually see, don't generalize. Return ONLY minified JSON, no markdown: {` +
    `"angle":"<core marketing angle / persuasion strategy, <=12 words>",` +
    hookField +
    `"creative":"<read of the creative: format/style (UGC, studio, lifestyle, before/after, text-heavy, meme, product demo, founder...), what is shown, key on-screen text, <=26 words>"` +
    applyField + `}.` + brandLine;
  const run = async (withImg) => {
    const content = [];
    if (withImg && img) content.push({ type: 'image', source: img });
    content.push({ type: 'text', text: 'COPY: ' + (t || '(no copy provided)') + (script ? '\n\nVIDEO SCRIPT (spoken audio, transcribed): ' + script : '') });
    // Creative reads are the app's single biggest AI cost: one VISION call per new ad /
    // post, ~900/day across the watchlist. Sonnet is the right tier here — the output is a
    // few short descriptive lines, not deep reasoning — and it cuts the bill twice over:
    // the per-token rate is ~40% lower than Opus AND Sonnet caps images at 1568px (~1.6k
    // image tokens) where Opus 4.7+ accepts 2576px (~4.8k), so a full-res creative bills
    // ~3x less. Override with ANGLE_MODEL to go back to Opus for quality.
    const resp = await client().messages.create({ model: process.env.ANGLE_MODEL || INSIGHTS_MODEL, max_tokens: 400, system, messages: [{ role: 'user', content }] });
    const raw = oneLine((resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''));
    let o = null;
    try { o = JSON.parse(raw); } catch (e) { const m = raw.match(/\{[\s\S]*\}/); if (m) { try { o = JSON.parse(m[0]); } catch (_) { /* noop */ } } }
    o = o || {};
    return {
      angle: oneLine(o.angle).replace(/^["'\s]+|["'\s.]+$/g, '').slice(0, 100) || raw.replace(/[{}"]/g, '').slice(0, 100),
      hook: oneLine(o.hook).slice(0, 170),
      creative: (withImg && img) ? oneLine(o.creative).slice(0, 220) : '',
      apply: oneLine(o.apply).slice(0, 220),
      script: script ? script.slice(0, 340) : '',
    };
  };
  try {
    const out = await run(true);
    _angleSet(key, out);
    return out;
  } catch (e) {
    console.warn('quickAngle vision failed (' + e.message + ') — retrying copy-only');
    if (img) { try { const out = await run(false); _angleSet(key, out); return out; } catch (e2) { /* fall through */ } }
    return { angle: '', hook: '', creative: '', apply: '' };
  }
}

// Pre-compute each ad/post's creative HOOK + ANGLE + CREATIVE read (vision, plus video
// transcription) DURING the daily capture and store it on the item — so the chat has the
// visual-level hooks for every ad/post without the user ever opening one. Optimized:
//   • cached per CREATIVE — carries forward the read from recent snapshots for unchanged
//     creatives, so only genuinely NEW creatives cost a vision call;
//   • uid=null → tenant-neutral (no per-viewer "apply"), so it's safe to bake into the
//     shared snapshot the chat reads;
//   • a per-competitor run BUDGET caps how many new reads happen per warm (bounds cost;
//     leftover new creatives get their read on the next run). Ads consume the budget first.
export function newHookBudget() { return { left: Number(process.env.AD_HOOK_CAP) || 30 }; }
// Cache identity for a creative's vision read. STABLE ids only: ad archive id / post permalink /
// ad-library link. The old key fell through to the raw image URL — but social CDN URLs are SIGNED
// with rotating params (oh/oe change every scrape), so the same post re-vision-read every single
// day (~$30-50/mo of pure waste, audit cost finding). If only a media URL exists, key on its PATH
// (the media id — stable) with the signed query stripped.
function creativeKey(a) {
  if (!a) return '';
  const stable = a.id || a.url || a.link;
  if (stable) return String(stable).slice(0, 220);
  return String(a.image || a.video || '').split('?')[0].slice(0, 220);
}
export async function enrichCreativeHooks(host, channel, kind, items, budget) {
  if (!process.env.ANTHROPIC_API_KEY || !Array.isArray(items) || !items.length) return;
  budget = budget || newHookBudget();
  const prior = new Map();
  try {
    for (const s of await recentSnapshots(host, channel, 3)) {
      for (const a of ((s.data && (s.data.ads || s.data.posts)) || [])) {
        if (a && a.hook) prior.set(creativeKey(a), { hook: a.hook, angle: a.angle || '', creative: a.creative || '' });
      }
    }
  } catch (e) { /* no prior read to reuse */ }
  for (const it of items) {
    const hit = prior.get(creativeKey(it));
    if (hit) { it.hook = hit.hook; it.angle = hit.angle; it.creative = hit.creative; continue; }
    if (budget.left <= 0) continue;   // cost cap reached — the rest get their read next run
    try {
      const r = await quickAngle(it.text || it.title || '', kind, it.image, it.video, null);
      if (r && (r.hook || r.angle)) { it.hook = r.hook; it.angle = r.angle; it.creative = r.creative; budget.left--; }
    } catch (e) { /* skip this creative */ }
  }
}

// Per-VIEWER "apply to your brand" overlay. The shared per-host insights snapshot is
// tenant-neutral (see generateInsights). When a SIGNED-IN client who has set up their own
// brand reads a competitor, we layer THEIR tailored apply-moves + counter-op on top —
// generated from the neutral summaries + their brand profile, and cached under a PRIVATE
// per-user key ('applyov:<uid>:<host>'). That key contains ':' so isPublicHost rejects it,
// and it is read only via latestSnapshot — it is NEVER written to the shared host snapshot
// nor returned by the public /api/snapshot|/api/history routes, so nothing crosses tenants.
async function applyOverlay(host, uid, neutral) {
  if (!uid || !neutral || !process.env.ANTHROPIC_API_KEY) return null;
  const me = await getMyBrand(uid);
  if (!me || !me.profile) return null;   // no brand set → nothing to tailor; show the neutral read
  const key = 'applyov:' + uid + ':' + host;
  const base = neutral.generatedAt || '';   // regenerate whenever the underlying neutral read changes
  const brandAt = me.builtAt || '';         // …or whenever the client re-scans / changes their own brand
  try { const cached = await latestSnapshot(key, 'overlay'); if (cached && cached.base === base && cached.brandAt === brandAt && cached.channels) return cached; }
  catch (e) { /* regenerate */ }

  const parts = [];
  for (const [k, label] of [['ads', 'ADS'], ['social', 'SOCIAL'], ['website', 'WEBSITE'], ['email', 'EMAIL']]) {
    const c = neutral[k];
    if (c && (c.summary || (c.bullets && c.bullets.length))) parts.push(`${k} | ${label}: ${c.summary || ''}${(c.bullets && c.bullets.length) ? ' — ' + c.bullets.join(' · ') : ''}`);
  }
  const verdict = toBullets(neutral.brief && neutral.brief.verdict, 3).join('; ');
  if (!parts.length && !verdict) return null;
  const system =
    `You are ${me.name}'s DIRECTOR OF GROWTH. Below are per-channel intelligence reads on a COMPETITOR (with the top-line THREAT). For EACH channel present, turn its most important takeaway into ONE realistic, specific move ${me.name} could actually make — grounded in their REAL products/prices/bundles below, naming a real one where you can; if a move needs real spend/effort, name it briefly; if a channel's takeaway genuinely doesn't fit their catalogue, give a one-line honest note instead of forcing it. Start each with a verb, ≤ 34 words, finish the sentence. Also write "move": 2 to 3 SHORT, SCANNABLE BULLET POINTS, each ONE concrete counter-op for ${me.name} against this competitor (each ≤ 13 words, telegraphic, start with a verb, cut filler), grounded in their profile.\n` +
    `ADVISING BRAND — ${me.name}${me.mainProduct ? ' (main product: ' + me.mainProduct + ')' : ''}: ${me.profile}${me.catalog ? '\nTHEIR CATALOGUE (real products, prices, bundles): ' + me.catalog : ''}\n` +
    `Return ONLY minified JSON, no markdown: {"channels":{"ads":"<move or ''>","social":"...","website":"...","email":"..."},"move":["<counter-op bullet>", ...]}. Include ONLY the channel keys that appear in the input.`;
  try {
    const resp = await client().messages.create({ model: INSIGHTS_MODEL, max_tokens: 700, system, messages: [{ role: 'user', content: (verdict ? 'THREAT: ' + verdict + '\n' : '') + parts.join('\n') }] });
    const txt = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    let o; try { o = JSON.parse(txt.replace(/^```json?\s*/i, '').replace(/\s*```$/, '')); } catch (e) { return null; }
    if (!o || typeof o !== 'object') return null;
    const channels = {};
    for (const k of ['ads', 'social', 'website', 'email']) if (o.channels && o.channels[k]) channels[k] = clip(o.channels[k], 260);
    const result = { channels, move: toBullets(o.move, 3), base, brandAt, builtAt: new Date().toISOString() };
    await saveSnapshot(key, 'overlay', result);
    return result;
  } catch (e) { return null; }
}

// Read the latest cached insights; generate on demand if missing. When a signed-in client
// (uid) has their own brand, layer their per-viewer apply-moves on top of the tenant-neutral
// shared read — without ever mutating or re-saving the shared snapshot.
const _briefHeal = new Map();          // host -> last repair attempt, so a hard failure can't hammer the API
const BRIEF_HEAL_COOLDOWN = 15 * 60 * 1000;

export async function getInsights(host, name, refresh, uid) {
  let ins = refresh ? null : await latestSnapshot(host, 'insights');
  const channels = ins ? Object.keys(ins).filter((k) => k !== 'generatedAt' && k !== '__day') : [];
  // Cold-gen produces the shared, tenant-neutral snapshot (no viewer uid) — see generateInsights.
  if (channels.length === 0 && process.env.ANTHROPIC_API_KEY) ins = await generateInsights(name || host, host);
  if (!ins) return {};

  // Self-heal a MISSING brief. makeBrief is best-effort, so one transient API hiccup during
  // the nightly warm saves the report with channels but no THREAT ASSESSMENT — and because
  // the cold-gen above only fires at ZERO channels, that gap used to be permanent for the
  // day (found on Ancestral, 17 Jul). Rebuild just the brief from the channels already
  // captured: one call, no re-scrape, and it stays tenant-neutral (getMyBrand(null)).
  const hasRead = ['ads', 'social', 'website', 'email'].some((k) => ins[k]);
  if (!ins.brief && hasRead && process.env.ANTHROPIC_API_KEY) {
    const last = _briefHeal.get(host) || 0;
    if (Date.now() - last > BRIEF_HEAL_COOLDOWN) {
      _briefHeal.set(host, Date.now());
      try {
        const b = await makeBrief(name || host, ins, await getMyBrand(null), new Date());
        if (b) {
          ins.brief = b;
          const save = Object.assign({}, ins); delete save.__day;   // __day is a read-time marker, not data
          await saveSnapshot(host, 'insights', save);
          console.log('brief ' + host + ': repaired a missing THREAT ASSESSMENT');
        }
      } catch (e) { console.warn('brief heal ' + host + ':', e.message); }
    }
  }
  if (uid && isPublicHost(host)) {
    try {
      const ov = await applyOverlay(host, uid, ins);
      if (ov) {
        ins = Object.assign({}, ins);   // shallow copy — NEVER mutate the shared cached object
        for (const k of ['ads', 'social', 'website', 'email']) {
          if (ins[k] && ov.channels[k]) ins[k] = Object.assign({}, ins[k], { apply: ov.channels[k] });
        }
        if (ov.move && ov.move.length && ins.brief) ins.brief = Object.assign({}, ins.brief, { move: ov.move });
      }
    } catch (e) { /* fall back to the neutral read */ }
  }
  return ins || {};
}
