// Ads intelligence — pulls a competitor's live ads from the Meta Ad Library
// via an Apify scraper actor (Apify handles the blocking/captchas for us).
//
// Set these in Railway → your backend service → Variables:
//   APIFY_TOKEN       (required) your Apify API token
//   APIFY_ADS_ACTOR   the actor you pick from the Apify Store, e.g. "curious_coder~facebook-ads-library-scraper"

import { recentSnapshots, latestSnapshot } from './snapshots.js';
import Anthropic from '@anthropic-ai/sdk';

const TOKEN = process.env.APIFY_TOKEN;
const ACTOR = process.env.APIFY_ADS_ACTOR || 'curious_coder~facebook-ads-library-scraper';
const TTL = 26 * 60 * 60 * 1000; // 26h — a daily 5am pre-warm keeps this hot so users never wait
const cache = new Map();

const BRAND_MATCH_MODEL = process.env.BRAND_MODEL || 'claude-haiku-4-5';
let _ac;
function aiClient() { if (!_ac) _ac = new Anthropic(); return _ac; }
const _verdict = new Map();   // 'brand|advertiser|domain' -> { at, val } — cached AI brand-identity verdicts

// Confirmed Facebook page ids for brands whose KEYWORD search is a dead end (Meta's fuzzy
// match returns pollution — "CurrentBody" surfaces romance-novel ads containing the phrase
// "current body" — while the brand's own ads never rank). Page-scoped scanning via Meta's
// own page identity has zero ambiguity. Extend without a deploy via env AD_PAGE_IDS
// ("host:id,host:id"). CurrentBody's id read from the Ad Library typeahead, 22 Jul 2026.
const KNOWN_FB_PAGES = { 'currentbody.com': '183065794653' };
for (const kv of String(process.env.AD_PAGE_IDS || '').split(',')) {
  const [h, id] = kv.split(':').map((x) => String(x || '').trim());
  if (h && /^\d+$/.test(id || '')) KNOWN_FB_PAGES[h.toLowerCase()] = id;
}

// The brand's OWN Facebook page id(s), derived from stored captures: pages whose ads mostly
// land on the brand's domain (same rule attribution uses), seeded by KNOWN_FB_PAGES. Powers
// PAGE-FIRST coverage (founder doctrine, 22 Jul): "always check first what's coming from the
// page, and then if there is any whitelisting ads."
const _ownPages = new Map();   // host -> { day, ids }
export async function ownPageIdsFor(host) {
  const h = cleanAdsHost(host);
  if (!h) return [];
  const day = new Date().toISOString().slice(0, 10);
  const c = _ownPages.get(h);
  if (c && c.day === day) return c.ids;
  let ids = KNOWN_FB_PAGES[h] ? [KNOWN_FB_PAGES[h]] : [];
  try {
    const snap = await latestSnapshot(h, 'ads');
    const pg = {};
    const hostLbl = h.split('.')[0].replace(/[^a-z0-9]/g, '');
    for (const a of ((snap && snap.ads) || [])) {
      if (!a.pageId) continue;
      const e = (pg[a.pageId] = pg[a.pageId] || { total: 0, own: 0, name: '' });
      e.total++;
      if (!e.name && a.page) e.name = a.page;
      const dm = adDomain(a.landing);
      if (dm && (dm === h || dm.endsWith('.' + h))) e.own++;
    }
    // PAGE-FIRST scans only pages NAMED as the brand (folded, so "Frøya Organics" matches
    // "froyaorganics"): a shared persona page (Dr. Amy) can be MOSTLY-brand by landings and
    // still rent to other companies — scanning it drags their ads into the capture (24 Jul).
    Object.entries(pg)
      .filter(([, v]) => {
        if (!(v.own > 0 && v.own * 2 >= v.total)) return false;
        const pn = foldTxt(v.name).replace(/[^a-z0-9]/g, '');
        return !!hostLbl && !!pn && (pn.indexOf(hostLbl) >= 0 || hostLbl.indexOf(pn) >= 0);
      })
      .sort((x, y) => y[1].own - x[1].own)
      .forEach(([id]) => { if (!ids.includes(id)) ids.push(id); });
  } catch (e) { /* keyword ladder still covers us */ }
  ids = ids.slice(0, 2);
  _ownPages.set(h, { day, ids });
  return ids;
}

export async function fetchAds(brand, country, force, cacheOnly, host, pageId, debug) {
  brand = String(brand || '').trim();
  country = String(country || 'ALL').trim().toUpperCase();
  pageId = String(pageId || '').replace(/\D/g, '');   // numeric FB page id only (page-scoped scan)
  if (!brand && !pageId) { const e = new Error('Missing brand.'); e.status = 400; throw e; }
  if (!TOKEN) { const e = new Error('Ads provider not configured — set APIFY_TOKEN in Railway.'); e.status = 503; throw e; }

  const key = brand.toLowerCase() + '|' + country + (pageId ? '|p:' + pageId : '');
  const hit = cache.get(key);
  // A cached EMPTY capture never blocks a re-check — an empty result is cheap to re-verify
  // and locking it in for the TTL is how "0 ads live" survived for hours after the fix.
  if (!force && hit && Date.now() - hit.at < TTL && (hit.data.ads || []).length) return { ...hit.data, cached: true };
  // cacheOnly: never trigger a live scrape (used by the chat) — return empty on a miss.
  if (cacheOnly) return { brand, country, count: 0, active: 0, platforms: [], newest: '', ads: [], cacheMiss: true };

  // PAGE-SCOPED scan pulls one confirmed brand page's ads directly (no keyword flood); otherwise a
  // keyword search. The keyword search is sorted NEWEST-FIRST via the Ad Library's OWN url sort
  // (sort_data). This is the fix that actually works for keyword search — the actor's
  // scrapePageAds.sortBy only sorts the page-ads action, so without this the keyword search came back
  // in impressions order and brand-new low-impression launches (Smooche's Jul-17 batch) fell past the
  // cap. Newest-first means: light advertisers get their whole set, heavy ones get the recent window,
  // and a genuinely NEW ad is always captured.
  const sortQ = '&search_type=keyword_unordered&sort_data[direction]=desc&sort_data[mode]=relevancy_monthly_grouped';
  const searchUrl = pageId
    ? ('https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=' + encodeURIComponent(country) + '&view_all_page_id=' + pageId + '&search_type=page&media_type=all')
    : ('https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=' + encodeURIComponent(country) + '&q=' + encodeURIComponent(brand) + sortQ + '&media_type=all');

  const ADS_N = Number(process.env.ADS_COUNT) || 50;   // founder-set (20 Jul): newest-first sorting means 50 always contains the new launches; deeper pulls were pure Apify cost
  const endpoint =
    'https://api.apify.com/v2/acts/' + ACTOR +
    '/run-sync-get-dataset-items?token=' + encodeURIComponent(TOKEN) + '&timeout=300';

  // BRANDING-WORDING variants (founder rule, 22 Jul): the tracked NAME is how the client
  // writes the brand ("Current Body"), but Meta's keyword search matches the brand's OWN
  // wording — CurrentBody brands itself as ONE word, so the two-word query returned 0 ads
  // for a brand running plenty. When a query comes back EMPTY, retry with the name minus
  // spaces, then the domain label ("currentbody"), and keep the first wording that returns
  // real results. Extra scrapes only ever run on a 0-result query, so this costs nothing
  // for the brands whose name already matches their branding.
  // EXACT PHRASE first (founder cases, 22 Jul): unordered matching turns a multi-word name
  // into a junk magnet — "Pacific foods" matched every ad containing "pacific" AND "foods"
  // (seafood restaurants…), the junk filled the newest-50 window, and 23 of the brand's 24
  // real ads (its "X with Pacific Foods" partnership fleet) never made the capture. Exact
  // phrase returns the clean set. Ladder: name (exact) → name-minus-spaces (exact) → domain
  // label (exact) → name (unordered, the old behavior) as the last resort.
  const variants = [{ q: brand, st: 'keyword_exact_phrase' }];
  if (!pageId) {
    const pushV = (q, st) => { q = String(q || '').trim(); if (q && !variants.some((x) => x.q.toLowerCase() === q.toLowerCase() && x.st === st)) variants.push({ q, st }); };
    if (/\s/.test(brand)) pushV(brand.replace(/\s+/g, ''), 'keyword_exact_phrase');
    const label = String(host || '').split('.')[0];
    if (label && label.length >= 4) pushV(label, 'keyword_exact_phrase');
    pushV(brand, 'keyword_unordered');
  }

  async function runOne(qUrl, qTerm, activeSt, pid) {
    const input = {
      urls: [{ url: qUrl }],
      startUrls: [{ url: qUrl }],
      searchTerms: qTerm ? [qTerm] : [],
      count: ADS_N,
      maxItems: ADS_N,
      country,
      activeStatus: activeSt,
      scrapePageAds: true,
      'scrapePageAds.sortBy': 'most_recent',
      'scrapePageAds.activeStatus': activeSt,
      'scrapePageAds.countryCode': country,
      ...(pid ? { pageId: pid, pageIds: [pid] } : {}),
    };
    const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    if (!res.ok) { const t = await res.text().catch(() => ''); const e = new Error('Apify returned ' + res.status + '. ' + t.slice(0, 160)); e.status = 502; throw e; }
    const arr = await res.json();
    return Array.isArray(arr) ? arr : [];
  }

  let items = [], usedQuery = brand;
  if (pageId) {
    items = await runOne(searchUrl, '', 'all', pageId);
  } else {
    // 1) PAGE-FIRST (founder doctrine, 22 Jul): the brand's own page(s) scanned directly —
    //    Meta lists a page's ads exhaustively, so the core inventory never depends on the
    //    keyword lottery ("bare bones" the phrase buried Bare Bones the brand).
    if (host) {
      for (const pid of await ownPageIdsFor(host)) {
        try { items = items.concat(await runOne('https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=' + encodeURIComponent(country) + '&view_all_page_id=' + pid + '&search_type=page&media_type=all', '', 'active', pid)); }
        catch (e) { console.warn('fetchAds page-scan ' + host + ' [' + pid + ']:', e.message); }
      }
      if (items.length) console.log('✓ fetchAds ' + host + ': page-first scan captured ' + items.length + ' item(s) from the brand\'s own page(s)');
    }
    // 2) KEYWORD ladder — its job is the WHITELISTING/partnership ads other pages run.
    let kw = [];
    for (const v of variants) {
      const q = v.q;
      const sortQv = '&search_type=' + v.st + '&sort_data[direction]=desc&sort_data[mode]=relevancy_monthly_grouped';
      const qUrl = 'https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=' + encodeURIComponent(country) + '&q=' + encodeURIComponent(q) + sortQv + '&media_type=all';
      try { kw = await runOne(qUrl, q, 'active'); } catch (e) { if (!items.length) throw e; console.warn('fetchAds keyword ' + (host || brand) + ':', e.message); break; }
      usedQuery = q + (v.st === 'keyword_unordered' ? ' (unordered)' : '');
      if (kw.length) break;
      if (v !== variants[variants.length - 1]) console.log('fetchAds ' + (host || brand) + ': query "' + q + '" [' + v.st + '] returned 0 — retrying with the next variant');
    }
    // Merge: page inventory first, keyword finds after (normalize dedupes by ad id).
    items = items.concat(kw);
  }
  if (usedQuery !== brand && items.length) console.log('✓ fetchAds ' + (host || brand) + ': keyword wording used: "' + usedQuery + '"');

  const data = await normalize(items, brand, country, host, debug);
  if (debug && data._debug) data._debug.usedQuery = usedQuery;
  // KEYWORD DEAD END -> CONFIRMED-PAGE fallback: nothing attributable survived any wording
  // variant, but we hold the brand's confirmed Facebook page id — scan the page itself.
  if (!pageId && host && !data.ads.length && KNOWN_FB_PAGES[cleanAdsHost(host)]) {
    console.log('fetchAds ' + host + ': keyword search kept 0 ads — falling back to confirmed page ' + KNOWN_FB_PAGES[cleanAdsHost(host)]);
    const viaPage = await fetchAds(brand, country, true, false, host, KNOWN_FB_PAGES[cleanAdsHost(host)], debug);
    if (viaPage && viaPage.ads && viaPage.ads.length) { cache.set(key, { at: Date.now(), data: viaPage }); return viaPage; }
  }
  cache.set(key, { at: Date.now(), data });
  return data;
}
function cleanAdsHost(h) { return String(h || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '').toLowerCase(); }

function isTpl(s) { return !s || /\{\{[^}]*\}\}/.test(String(s)); }      // e.g. "{{product.brand}}"
function clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
function cardMedia(c) { return c.original_image_url || c.resized_image_url || c.video_preview_image_url || ''; }

// Keyword search in the Meta Ad Library drags in unrelated advertisers (e.g. a scooter
// brand surfacing under "oodie"). Keep only ads that actually belong to THIS brand —
// where a distinctive brand word appears in the page name, landing domain, or copy.
const BRAND_STOP = new Set(['the', 'and', 'for', 'shop', 'store', 'official', 'ltd', 'inc', 'llc', 'brand', 'online', 'buy', 'get', 'app', 'mobility', 'cosmetics', 'beauty', 'skincare', 'skin', 'care', 'fashion', 'clothing', 'apparel', 'wear', 'home', 'studio', 'company', 'group', 'global', 'world', 'collective']);
function brandTokens(brand) {
  return [...new Set(foldTxt(brand).split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !BRAND_STOP.has(w)))];
}
// The set of strings that identify the brand: its distinctive name words, PLUS the
// whole name with separators removed (so "The Oodie" → "theoodie", which is how it
// appears in its own domain theoodie.com and page name).
function brandKeys(brand) {
  const keys = new Set(brandTokens(brand));
  const full = foldTxt(brand).replace(/[^a-z0-9]+/g, '');
  if (full.length >= 4) keys.add(full);
  return keys;
}
// Split a name/domain into lowercased alphanumeric words. Domains break on dots AND
// hyphens ("super-hoodie.com" → super, hoodie, com), so a short key like "oodie" can
// never silently match inside "hoodie"/"foodie".
// Fold Nordic/accented characters BEFORE any name comparison (found 23 Jul): stripping
// non-ASCII turned "Frøya Organics" into "fryaorganics" while the tracked name folds to
// "froyaorganics" — no match, so the brand's OWN page classified as a whitelisted 3rd party.
const FOLD_MAP = { 'ø': 'o', 'æ': 'ae', 'å': 'a', 'œ': 'oe', 'ß': 'ss', 'đ': 'd', 'ð': 'd', 'þ': 'th', 'ł': 'l' };
export function foldTxt(s) {
  return String(s || '').toLowerCase().replace(/[\u00c0-\u024f]/g, (ch) => {
    if (FOLD_MAP[ch]) return FOLD_MAP[ch];
    const d = ch.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    return d || ch;
  });
}
function wordsOf(s) { return foldTxt(s).split(/[^a-z0-9]+/).filter(Boolean); }
function adMatchesBrand(a, keys) {
  if (!keys.size) return true; // no distinctive key → don't filter (fail open)
  // Attribute by IDENTITY, not body copy: a brand key must appear as a WHOLE WORD in
  // the real advertiser (Facebook page) or the landing domain. Whole-word matching is
  // what stops "The Oodie" from swallowing "Super Hoodie" / "Foodie Flavours" (whose
  // domains merely contain the letters "oodie"), and stops rivals/affiliates that only
  // name-drop the brand in ad copy from being counted as the brand's own funnels.
  const words = wordsOf(a.advertiser).concat(wordsOf(adDomain(a.landing)));
  return words.some((w) => keys.has(w));
}

// A one-line "what this brand actually sells" descriptor from the captured website
// snapshot (product titles + on-site promo) — so attribution can sanity-check that an
// advertiser's ADS make sense with the competitor's WEBSITE, not just its name/domain.
async function siteDescriptor(host) {
  try {
    const w = await latestSnapshot(host, 'website');
    const items = (w && w.summary && w.summary.items) ? Object.values(w.summary.items) : [];
    const titles = items.map((i) => clean(i && i.title).replace(/["\\]/g, '')).filter(Boolean).slice(0, 8);
    const bits = [];
    if (titles.length) bits.push('sells: ' + titles.join(', '));
    else if (w && w.summary && w.summary.products) bits.push('has ' + w.summary.products + ' products');
    if (w && w.banner) bits.push('on-site promo: ' + clean(w.banner).replace(/["\\]/g, ''));
    return bits.join('; ').slice(0, 320);
  } catch (e) { return ''; }
}

// ── AI brand attribution ───────────────────────────────────────────────────────
// The whole-word rules above are a free fallback. When a Claude key is present we let
// the model make the real judgment — "is this advertiser the SAME brand, or a
// different company?" — which handles what no string rule can: a rival named "Super
// Hoodie", the brand's own advertorial on a news domain, regional storefronts.
async function sameBrandVerdicts(brand, hint, distinct, desc) {
  const out = new Map(), ask = [];
  for (const d of distinct) {
    const ck = brand.toLowerCase() + '|' + d.advertiser.toLowerCase() + '|' + d.domain.toLowerCase();
    const c = _verdict.get(ck);
    if (c && Date.now() - c.at < 24 * 60 * 60 * 1000) out.set(d.id, c.val); else ask.push(d);
  }
  if (ask.length) {
    const rows = ask.map((d, i) => `${i + 1}. advertiser="${d.advertiser || '(unknown)'}" landing="${d.domain || '(none)'}"${d.sample ? ` ad-copy="${d.sample}"` : ''}`).join('\n');
    const system =
      `Decide for each row whether the ADVERTISER is the SAME brand as the target, or a DIFFERENT company. ` +
      `Target brand: "${brand}"${hint ? `. Its OFFICIAL SITE is ${hint} — that domain AND its subdomains are the brand's ground-truth identity` : ''}. ` +
      `${desc ? `The target's WEBSITE ${desc}. An advertiser whose ad-copy clearly promotes a DIFFERENT kind of business/product than that is NOT the target — answer DIFFERENT. ` : ''}` +
      `SAME = the brand itself: its own site/subdomains, its GENUINE regional stores (the same brand on a country version of ITS site), and its OWN advertorial/native-ad funnels (the advertiser is the brand even when the landing is a news/partner domain). ` +
      `DIFFERENT = a separate company: a competitor, reseller, affiliate, fan account, or an unrelated business that merely SHARES A NAME, WORD or SURNAME with the target — INCLUDING one on a DIFFERENT REGISTRABLE DOMAIN (e.g. a foreign ccTLD). Many businesses worldwide share a generic word (e.g. "brodo" means "broth" in Italian). ` +
      `A same-name ad on a DIFFERENT registrable domain than the official site is DIFFERENT unless there is clear evidence it is the target's OWN regional site — e.g. "brodo.ma" (a Morocco domain) is NOT "brodo.com" (a NYC bone-broth brand); "Campbells of Deal" (campbellsofdeal.co.uk, a UK car garage) is NOT "campbells.com". ` +
      `Do NOT call it the same just because the brand's letters appear inside another word ("Super Hoodie"/"Foodie Flavours" are DIFFERENT from "The Oodie"). ` +
      `PRECISION FIRST: it is far better to MISS one of the brand's ads than to include a DIFFERENT company's ad. When you are not confident it's the target brand, answer DIFFERENT. When the advertiser's domain/industry doesn't clearly match the official site, answer DIFFERENT. ` +
      `Return ONLY minified JSON: {"v":[{"i":1,"same":true|false}, ...]}, one entry per row.`;
    // 3000 tokens: a deep scrape can surface 50+ distinct advertisers; a tight budget made
    // the model silently return a PARTIAL verdict list (the 18 Jul leak's other half).
    const resp = await aiClient().messages.create({ model: BRAND_MATCH_MODEL, max_tokens: 3000, system, messages: [{ role: 'user', content: rows }] });
    const txt = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim().replace(/^```(?:json)?|```$/g, '').trim();
    const parsed = JSON.parse(txt);
    const arr = Array.isArray(parsed.v) ? parsed.v : [];
    if (!arr.length) throw new Error('no verdicts');
    ask.forEach((d, idx) => {
      const hitv = arr.find((x) => Number(x.i) === idx + 1);
      // FAIL CLOSED on a skipped row (founder precision doctrine). The old default was
      // `true` — on 18 Jul a deep scrape produced a row list the model answered only
      // partially, and every unanswered advertiser was KEPT: six Alibaba.com ads shipped
      // as "Rubber B's". A skipped row is now DIFFERENT; the brand's own ads can't be
      // lost by this — own-domain/own-page/branded-content/alias ads are kept BEFORE the
      // verdict is consulted. Skips are NOT cached, so the next capture re-asks.
      const val = hitv ? !!hitv.same : false;
      out.set(d.id, val);
      if (hitv) _verdict.set(brand.toLowerCase() + '|' + d.advertiser.toLowerCase() + '|' + d.domain.toLowerCase(), { at: Date.now(), val });
    });
  }
  return out;
}

// Keep only the ads that really belong to `brand`. The AI decides per distinct
// advertiser; whole-word string rules are the fallback when no key / on error.
async function filterToBrand(brand, ads, hostDom, desc) {
  if (!ads.length) return ads;
  const keys = brandKeys(brand);
  if (hostDom) brandTokens(hostDom).forEach((k) => keys.add(k));   // the brand's OWN domain label is a strong identity key
  // An ad landing on the brand's OWN domain (or a subdomain, e.g. drink.brodo.com for
  // brodo.com) is DEFINITIVELY the brand's — never let fuzzy matching drop it.
  const onOwnDomain = (a) => { if (!hostDom) return false; const d = adDomain(a.landing); return !!d && (d === hostDom || d.endsWith('.' + hostDom)); };
  // Identify the brand's OWN Facebook pages: page_ids where MOST ads land on the brand's
  // domain. Their OTHER ads — the brand's own advertorials/partner funnels that send
  // traffic to a 3RD-PARTY domain — are still the brand's, so keep them via the page even
  // when the landing domain differs. Impostor/network pages don't qualify (their ads don't
  // land on the brand's domain), so this never resurfaces unrelated advertisers.
  const pg = {};
  for (const a of ads) { const p = a.pageId; if (!p) continue; (pg[p] = pg[p] || { total: 0, own: 0 }).total++; if (onOwnDomain(a)) pg[p].own++; }
  const brandPages = new Set(Object.keys(pg).filter((p) => pg[p].own > 0 && pg[p].own * 2 >= pg[p].total));
  const onBrandPage = (a) => !!(a.pageId && brandPages.has(a.pageId));
  // Meta's OWN attribution: the ad is branded content "<persona> with <BRAND>". A whole-word brand
  // match in that partner name is definitive (and precise — a "with Qure Skincare" ad never matches
  // "seranova"), so it keeps a brand's persona/advertorial ads that run onto neutral funnels.
  const onBrandedContent = (a) => { const w = new Set(wordsOf((a.partner || '') + ' ' + (a.byline || ''))); return [...keys].some((k) => k.length >= 5 && w.has(k)); };
  // The brand's OWN alt domains a strict host match misses: a DISTINCTIVE (>=7-char) brand name as a
  // whole domain label (regional site seranova.co.za) or a label = brand + a common descriptor
  // (seranovabeauty.com = "seranova"+"beauty", where Seranova runs its advertorial funnels). The
  // length guard keeps this OFF short/common names, so it never re-admits brodo.ma for "brodo".
  const DESCR = /^(beauty|skincare|skin|care|cosmetics|shop|store|official|hq|co|labs?|club|online|global|world|group|brand|us|usa|uk|eu)$/;
  // A COUNTRY-TLD twin is NOT auto-own (found 22 Jul): bonafide.com.ar is Café Bonafide,
  // a century-old ARGENTINE chocolate chain — not Bonafide Provisions, the US broth brand.
  // Two unrelated companies can share a trade name across countries, so an exact-label match
  // on a DIFFERENT suffix than the brand's own domain goes to the AI judge (which holds the
  // site descriptor and fails closed) instead of auto-keeping. Same-suffix aliases
  // (seranovabeauty.com for seranova.com) still auto-keep.
  const hostSuffix = hostDom ? hostDom.split('.').slice(1).join('.') : '';
  const onAliasDomain = (a) => {
    const dm = adDomain(a.landing); if (!dm) return false;
    const labels = dm.split('.');
    return [...keys].some((k) => k.length >= 7 && labels.some((L, i) => {
      if (!(L === k || (L.startsWith(k) && DESCR.test(L.slice(k.length))))) return false;
      if (!hostSuffix) return true;                                   // no domain anchor → old behavior
      return labels.slice(i + 1).join('.') === hostSuffix;            // ccTLD twin → judge decides
    }));
  };
  // Precision first (founder rule: NEVER show a random business — better to miss a brand ad
  // than show a different company's). When we know the brand's domain, keep ONLY its own-domain
  // ads, its own-page ads, branded-content-to-the-brand ads, and AI-confirmed ones — bare brand-NAME
  // matching is disabled (it's what let "brodo.ma"/"BRODO Footwear" through). Name matching only fills
  // in when we have NO domain to anchor on (fail-open so a domain-less brand isn't blanked).
  // A "brand page" can be a SHARED persona page renting to a whole network (found 24 Jul:
  // "Dr. Amy" runs Frøya ads AND Norse Organics acne, Arctic Goddess supplements, PrimalViking
  // TRT — three other companies' ads were auto-kept and reported as Frøya's new funnels). An
  // ad from a brand page is auto-kept only when its landing is the brand's own/alias domain or
  // it has no landing (Page-Like); a FOREIGN landing from a shared page faces the AI judge.
  const brandPageSafe = (a) => onBrandPage(a) && (!adDomain(a.landing) || onOwnDomain(a) || onAliasDomain(a));
  const stringKeep = (a) => onOwnDomain(a) || brandPageSafe(a) || onBrandedContent(a) || onAliasDomain(a) || (hostDom ? false : (!keys.size ? true : adMatchesBrand(a, keys)));
  if (!process.env.ANTHROPIC_API_KEY) return ads.filter(stringKeep);
  const idOf = (a) => (a.advertiser || '') + '|' + (adDomain(a.landing) || '');
  // Attach a sample of each distinct advertiser's ad copy so the AI can sanity-check the
  // ADS against the brand's website business (not just match the name/domain).
  const distinct = [...new Map(ads.map((a) => [idOf(a), { id: idOf(a), advertiser: a.advertiser || '', domain: adDomain(a.landing) || '', sample: clean(a.text || a.title || '').replace(/["\\]/g, '').slice(0, 140) }])).values()];
  // The brand's REAL domain is the ground-truth identity hint. Only when we don't know it
  // do we GUESS the most common brand-looking landing domain from the ads themselves —
  // which is dangerous when a keyword search returns a same-named different company (the
  // guess would then be the impostor's domain and the model would confirm it).
  let hint = hostDom;
  if (!hint) {
    const own = {};
    ads.forEach((a) => { const dm = adDomain(a.landing); if (dm && keys.size && adMatchesBrand(a, keys)) own[dm] = (own[dm] || 0) + 1; });
    hint = (Object.entries(own).sort((a, b) => b[1] - a[1])[0] || [''])[0];
  }
  try {
    const verdict = await sameBrandVerdicts(brand, hint, distinct, desc);
    // Own-domain ads and ads from the brand's OWN pages are ALWAYS kept (the latter catches
    // the brand's advertorials that send traffic to a 3rd-party domain); other off-domain ads
    // follow the AI verdict — so a same-name ad on a DIFFERENT registrable domain (brodo.ma vs
    // brodo.com) is dropped, while the brand's own funnels (drink.brodo.com) always survive.
    return ads.filter((a) => { if (onOwnDomain(a) || brandPageSafe(a) || onBrandedContent(a) || onAliasDomain(a)) return true; const v = verdict.get(idOf(a)); return v === undefined ? stringKeep(a) : v; });
  } catch (e) {
    // AI error → be CONSERVATIVE when we know the brand's domain: keep only its own-domain
    // ads + ads from its own pages (whole-word name matching is unreliable for a generic name
    // like "Brodo", which matches BRODO Footwear, brodo.ma, etc.). No known domain → names.
    return ads.filter((a) => hostDom ? (onOwnDomain(a) || brandPageSafe(a) || onBrandedContent(a) || onAliasDomain(a)) : stringKeep(a));
  }
}

// De-duplicate ads — never show the same creative twice. Two ads are "the same" if
// they share an image URL, or have the same landing + format and identical/≥90%-similar
// copy (the Meta library returns the same creative under many ad IDs / placements).
function normDup(t) { return String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function dupToks(t) { return new Set(normDup(t).split(' ').filter(Boolean)); }
function jaccard(a, b) { if (!a.size || !b.size) return a.size === b.size ? 1 : 0; let i = 0; a.forEach((w) => { if (b.has(w)) i++; }); return i / (a.size + b.size - i); }
function dedupeAds(ads) {
  // TRUE duplicates ONLY: the same ad listed twice by the scrape (same archive id, or the exact
  // same creative file). FOUNDER RULE (20 Jul): in ecomm the copy/headline/URL are usually
  // IDENTICAL across a launch batch — the CREATIVE (video/image) is what's being tested — so
  // same-copy-different-creative are DIFFERENT ads and must NEVER be merged. No fuzzy matching.
  const seen = new Set(), kept = [];
  for (const a of ads) {
    const k = a.id ? ('id:' + a.id)
      : (a.image ? ('img:' + String(a.image).split('?')[0])
      : ('tx:' + normDup(a.text || a.title).slice(0, 80) + '|' + adDomain(a.landing) + '|' + fmtOf(a)));
    if (seen.has(k)) continue;
    seen.add(k); kept.push(a);
  }
  return kept;
}

// Map the Facebook Ad Library actor's items to a clean, display-ready shape.
// Many eComm ads are dynamic catalog ads whose body is a "{{product.brand}}"
// template — the real copy and creative then live in the per-product `cards` array.
async function normalize(items, brand, country, host, debug) {
  const ads = items.map((it) => {
    const snap = it.snapshot || {};
    const cards = Array.isArray(snap.cards) ? snap.cards : [];
    const imgs = Array.isArray(snap.images) ? snap.images : [];
    const vids = Array.isArray(snap.videos) ? snap.videos : [];

    // Body copy — skip {{templates}}, borrow real copy from the first usable card.
    let text = isTpl(snap.body && snap.body.text) ? '' : clean(snap.body && snap.body.text);
    if (!text) { const c = cards.find((c) => !isTpl(c.body)); if (c) text = clean(c.body); }
    let title = isTpl(snap.title) ? '' : clean(snap.title);
    if (!title) { const c = cards.find((c) => !isTpl(c.title)); if (c) title = clean(c.title); }
    if (!text) text = title;

    // Creative thumbnail — images, then video poster, then card media.
    let image =
      (imgs[0] && (imgs[0].original_image_url || imgs[0].resized_image_url)) ||
      (vids[0] && vids[0].video_preview_image_url) || '';
    if (!image) { const c = cards.find((c) => cardMedia(c)); if (c) image = cardMedia(c); }

    const platforms = Array.isArray(it.publisher_platform)
      ? it.publisher_platform
      : (it.publisher_platform ? [it.publisher_platform] : []);

    return {
      id: String(it.ad_archive_id || it.ad_id || ''),
      text,
      title,
      image,
      hasVideo: vids.length > 0 || cards.some((c) => c.video_sd_url || c.video_hd_url),
      video: (() => { const v = vids.find((x) => x.video_sd_url || x.video_hd_url) || cards.find((x) => x.video_sd_url || x.video_hd_url); return v ? (v.video_sd_url || v.video_hd_url) : ''; })(),
      page: it.page_name || snap.page_name || brand,
      advertiser: it.page_name || snap.page_name || '',   // real Facebook advertiser; '' if the actor omits it — used to attribute the ad to a brand
      pageId: String(it.page_id || snap.page_id || (it.snapshot && it.snapshot.page_id) || ''),   // FB page id — lets us pin scanning to the confirmed brand page

      platforms,
      format: snap.display_format || (cards.length > 1 ? 'CAROUSEL' : 'IMAGE'),
      cta: snap.cta_text || '',
      landing: snap.link_url || (cards[0] && cards[0].link_url) || '',
      started: String(it.start_date_formatted || it.start_date || '').split(' ')[0],
      active: it.is_active !== false,
      // Branded-content partner ("<persona> with <BRAND>" in the Ad Library) — Meta's OWN attribution
      // of an advertorial to the brand it promotes. The precise way to keep a brand's persona/affiliate
      // ads (which run from other pages onto neutral funnels) while excluding a DIFFERENT brand's ads
      // that share the same advertorial network (e.g. a "with Qure Skincare" ad under a Seranova search).
      partner: (snap.branded_content && (snap.branded_content.page_name || '')) || '',
      partnerId: String((snap.branded_content && snap.branded_content.page_id) || ''),
      byline: clean(snap.byline || it.byline || ''),   // "<persona> with <BRAND>" line — Meta's other place for the brand association when branded_content is absent

      link: it.ad_library_url || (it.ad_archive_id ? 'https://www.facebook.com/ads/library/?id=' + it.ad_archive_id : ''),
    };
  }).filter((a) => a.text || a.image);

  // Decide which ads are really THIS brand's — the AI judges each distinct advertiser
  // against the brand's OWN domain AND what its website actually sells (so the ads profile
  // has to make sense with the site). String rules are the fallback inside filterToBrand.
  const hostDom = hostToDomain(host);
  const desc = hostDom ? await siteDescriptor(hostDom) : '';
  let kept = await filterToBrand(brand, ads, hostDom, desc);
  if (!kept.length) {
    // Attribution kept nothing. Rather than resurface unrelated advertisers a keyword
    // search dragged in (e.g. "Campbells of Deal" for campbells.com), keep ONLY ads that
    // land on the brand's OWN domain when we know it; with no known domain, keep all.
    kept = hostDom ? ads.filter((a) => { const d = adDomain(a.landing); return d && (d === hostDom || d.endsWith('.' + hostDom)); }) : ads;
  }
  const unique = dedupeAds(kept);   // never show the same creative twice

  const platforms = [...new Set(unique.flatMap((a) => a.platforms))];
  const newest = unique.map((a) => a.started).filter(Boolean).sort().slice(-1)[0] || '';
  const dbg = debug ? {
    rawCount: ads.length,
    keptCount: unique.length,
    rawNewest: ads.map((a) => a.started).filter(Boolean).sort().slice(-1)[0] || '',
    rawStarts: [...new Set(ads.map((a) => a.started).filter(Boolean))].sort().slice(-14),
    recentRaw: ads.filter((a) => String(a.started || '') >= '2026-07-13').slice(0, 15).map((a) => ({ started: a.started, page: a.page, land: adDomain(a.landing), kept: unique.some((u) => adKey(u) === adKey(a)) })),
  } : undefined;
  return {
    brand,
    country,
    count: unique.length,
    active: unique.filter((a) => a.active).length,
    platforms,
    newest,
    ads: unique.slice(0, 300),   // keep the full set for day-over-day "what's new" diffing
    ...(dbg ? { _debug: dbg } : {}),
  };
}

// ── "What's new" detection — compare today's ads to the most recent earlier
// capture and surface ONLY the new ones, tagged by why they're notable
// (new landing page / domain, new Facebook page, new creative format). ──
function adKey(a) { return a.id || a.link || a.image || ((a.page || '') + '|' + String(a.text || '').slice(0, 40)); }
function startedRecently(started, tStr, days) {
  const s = String(started || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = (Date.parse(tStr) - Date.parse(s)) / 86400000;
  return d >= 0 && d <= days;
}
export function adDomain(u) { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { return ''; } }
// A competitor's own host (e.g. "campbells.com" or "https://campbells.com/x") → bare domain.
function hostToDomain(h) { h = String(h || '').trim(); if (!h) return ''; return adDomain(/^https?:\/\//i.test(h) ? h : ('https://' + h)); }
function fmtOf(a) { return a.hasVideo ? 'video' : (a.format && /carousel/i.test(a.format) ? 'carousel' : 'image'); }

// A "landing" worth surfacing as a clickable funnel: a real, openable web page —
// NOT an app deep-link, link-shortener, social/click redirect or other non-page URL
// (those don't work when clicked and aren't real landing pages, e.g. cooltra.onelink.me).
const JUNK_LANDING = /(?:^|\.)(onelink\.me|app\.link|go\.link|smart\.link|adj\.st|bnc\.lt|branch\.io|page\.link|bit\.ly|tinyurl\.com|t\.co|lnk\.to|linktr\.ee|rebrand\.ly|ow\.ly|buff\.ly|cutt\.ly|fb\.me|m\.me|wa\.me|api\.whatsapp\.com|l\.facebook\.com|lm\.facebook\.com)$/i;
export function isFunnelUrl(u) {
  if (!/^https?:\/\//i.test(String(u || ''))) return false;        // must be a real web URL
  const dom = adDomain(u);
  if (!dom || dom.indexOf('.') < 0 || /\s/.test(dom)) return false; // need a valid public domain
  if (/^(facebook|instagram|fb)\.com$/i.test(dom)) return false;    // points back to the platform, not a funnel
  return !JUNK_LANDING.test(dom);
}

// NEVER HYPERLINK A DEAD PAGE (founder rule, 23 Jul): before any surface links a landing
// URL, verify it answers. Cached per URL per day; unknown (timeout/network) counts as DEAD —
// a link we can't vouch for isn't a link we publish.
const _urlAlive = new Map();   // url -> { day, ok }
export async function urlAlive(u) {
  u = String(u || '');
  if (!/^https?:\/\//i.test(u)) return false;
  const day = new Date().toISOString().slice(0, 10);
  const c = _urlAlive.get(u);
  if (c && c.day === day) return c.ok;
  let ok = false;
  try {
    const UA_ = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
    let r = await fetch(u, { method: 'HEAD', redirect: 'follow', headers: { 'User-Agent': UA_ }, signal: AbortSignal.timeout(8000) }).catch(() => null);
    if (!r || (r.status >= 400 && r.status !== 405)) r = await fetch(u, { redirect: 'follow', headers: { 'User-Agent': UA_ }, signal: AbortSignal.timeout(10000) }).catch(() => null);
    ok = !!(r && r.status < 400);
  } catch (e) { ok = false; }
  _urlAlive.set(u, { day, ok });
  return ok;
}

// Does this Facebook page run ANY active ad right now? A minimal page-scoped scan (5 items)
// — the definitive check behind the "page retired" signal. Cached per page per day so
// repeated brief/panel builds never re-pay it. null = couldn't determine (treat as no proof).
const _pageProbe = new Map();   // pageId -> { day, val }
async function pageHasActiveAds(pageId, country) {
  pageId = String(pageId || '').replace(/\D/g, '');
  if (!TOKEN || !pageId) return null;
  const day = new Date().toISOString().slice(0, 10);
  const c = _pageProbe.get(pageId);
  if (c && c.day === day) return c.val;
  try {
    const url = 'https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=' + encodeURIComponent(country || 'ALL') + '&view_all_page_id=' + pageId + '&search_type=page&media_type=all';
    const input = { urls: [{ url }], startUrls: [{ url }], count: 5, maxItems: 5, country: country || 'ALL', activeStatus: 'active', scrapePageAds: true, 'scrapePageAds.activeStatus': 'active' };
    const res = await fetch('https://api.apify.com/v2/acts/' + ACTOR + '/run-sync-get-dataset-items?token=' + encodeURIComponent(TOKEN) + '&timeout=120', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    if (!res.ok) return null;
    const items = await res.json();
    const val = Array.isArray(items) ? items.length > 0 : null;
    _pageProbe.set(pageId, { day, val });
    return val;
  } catch (e) { return null; }
}

export async function adsChanges(host, todayAds, asOfDay) {
  const today = todayAds || [];
  if (!host) return null;
  const recent = await recentSnapshots(host, 'ads', 6);
  // Anchor "today" to the DAY OF THE CAPTURE being analyzed, not the wall clock. The morning
  // brief (8am) analyzes last night's 23:00 capture — with a wall-clock anchor, that capture's
  // own day ≠ today, so it was picked as its own "previous" and every diff came back empty:
  // ads signals (new funnel / new FB page / new ads) silently never fired in a morning brief
  // (Glov's doctor-persona pages, 21 Jul). Callers pass the snapshot's day; live scrapes omit it.
  const tStr = /^\d{4}-\d{2}-\d{2}$/.test(String(asOfDay || '')) ? String(asOfDay) : new Date().toISOString().slice(0, 10);
  const prevSnap = recent.find((s) => s.day < tStr && s.data && Array.isArray(s.data.ads) && s.data.ads.length);
  const prev = (prevSnap && prevSnap.data.ads) || [];
  // No comparable prior capture (first run, or the previous scan was much shallower — e.g. right
  // after we raised the scrape cap) → treat as baseline: don't flag the whole diff, which would be
  // a false BURST of previously-uncaptured OLD ads. BUT an ad that genuinely LAUNCHED in the last
  // few days is new regardless of capture depth, so still surface those (not in prev, started recently).
  if (!prev.length || prev.length < today.length * 0.6) {
    const prevIds0 = new Set(prev.map(adKey));
    const freshNew = today.filter((a) => !prevIds0.has(adKey(a)) && startedRecently(a.started, tStr, 4));   // every one counts (no dedup — founder rule)
    return { baseline: true, newCount: freshNew.length, newAds: freshNew.slice(0, 30).map((a) => ({ ...a, tags: [] })), signals: { landings: [], pages: [], formats: [] } };
  }
  const prevIds = new Set(prev.map(adKey));
  const prevLand = new Set(prev.map((a) => adDomain(a.landing)).filter(Boolean));
  const prevPages = new Set(prev.map((a) => String(a.page || '').toLowerCase()).filter(Boolean));
  const prevFmts = new Set(prev.map(fmtOf));
  const fresh = [];
  const landingUrl = {}; // domain -> first full landing URL, so the chip can link to the real funnel
  for (const a of today) {
    if (prevIds.has(adKey(a))) continue;
    const tags = [];
    const dom = adDomain(a.landing);
    if (dom && !prevLand.has(dom) && isFunnelUrl(a.landing)) { tags.push({ k: 'landing', v: dom }); if (!landingUrl[dom]) landingUrl[dom] = a.landing; }
    if (a.page && !prevPages.has(String(a.page).toLowerCase())) tags.push({ k: 'page', v: a.page });
    const f = fmtOf(a);
    if (!prevFmts.has(f)) tags.push({ k: 'format', v: f });
    fresh.push({ ...a, tags });
  }
  const uniq = (arr) => [...new Set(arr)];
  const signals = {
    landings: uniq(fresh.flatMap((a) => a.tags.filter((t) => t.k === 'landing').map((t) => t.v))).map((domain) => ({ domain, url: landingUrl[domain] })),
  };
  // Verify funnel links before they can be hyperlinked anywhere (founder: never link a dead
  // or incomplete page). A dead URL keeps the domain fact but loses its link.
  for (const l of signals.landings) { if (l.url && !(await urlAlive(l.url))) l.url = ''; }
  Object.assign(signals, {
    pages: uniq(fresh.filter((a) => a.tags.some((t) => t.k === 'page')).map((a) => a.page)),
    formats: uniq(fresh.flatMap((a) => a.tags.filter((t) => t.k === 'format').map((t) => t.v))),
  });
  // DROPPED Facebook-page detection (founder, 21 Jul — Tallowed Truth's 'Non-Woke Daily'
  // advertorial page vanished and nothing called it out): a non-own Facebook page that
  // advertised in the previous capture and has NO ads today. Two proofs, precision-first:
  //  1. FREE: today's newest-first capture reaches BACK past the page's newest ad — a
  //     still-active ad inside the covered date range would have been captured.
  //  2. PROBE: when the window can't prove it (the page's ads are older than the capture
  //     reaches — maybe retired, maybe just buried under newer launches), ask Meta
  //     directly: a tiny page-scoped scan (5 items, cached 24h, max 2/run) answers
  //     "does this page run ANY active ad?" definitively. No proof → stay silent.
  signals.droppedPages = [];
  {
    const hostLabel = hostToDomain(host).split('.')[0].replace(/[^a-z0-9]/g, '');
    const ownPg = (p) => { const c = foldTxt(p).replace(/[^a-z0-9]/g, ''); return !hostLabel || !c || c.indexOf(hostLabel) >= 0 || hostLabel.indexOf(c) >= 0; };
    const todayPg = new Set(today.map((a) => String(a.page || '').toLowerCase()).filter(Boolean));
    const oldestToday = today.map((a) => String(a.started || '').slice(0, 10)).filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s)).sort()[0] || '';
    const cand = {};
    for (const a of prev) {
      const p = String(a.page || ''); const k = p.toLowerCase();
      if (!p || todayPg.has(k) || ownPg(p)) continue;
      const s = String(a.started || '').slice(0, 10);
      if (!cand[k] || s > cand[k].s) cand[k] = { p, s, pageId: String(a.pageId || '') };
    }
    let probes = 0;
    for (const k of Object.keys(cand)) {
      const e = cand[k];
      if (e.s && oldestToday && e.s >= oldestToday) { signals.droppedPages.push(e.p); continue; }   // proof 1
      if (e.pageId && probes < 2) {                                                                 // proof 2
        probes++;
        try { if ((await pageHasActiveAds(e.pageId)) === false) signals.droppedPages.push(e.p); } catch (err) { /* no proof → silent */ }
      }
    }
    signals.droppedPages = signals.droppedPages.slice(0, 4);
  }
  // EVERY fresh ad is reported — no dedup/collapse (FOUNDER RULE 20 Jul: each creative is a
  // distinct ad; the count is the real number of new launches). Ranking only orders the list:
  // new FB PAGE (handle) > new FUNNEL (landing URL) > new FORMAT, then newest first.
  const rank = (a) => { const has = (k) => (a.tags || []).some((t) => t.k === k); return has('page') ? 3 : has('landing') ? 2 : has('format') ? 1 : 0; };
  const ranked = fresh.slice().sort((x, y) => rank(y) - rank(x) || String(y.started || '').localeCompare(String(x.started || '')));
  return { baseline: false, newCount: ranked.length, newAds: ranked.slice(0, 30), signals };
}
