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

export async function fetchAds(brand, country, force, cacheOnly, host, pageId, debug) {
  brand = String(brand || '').trim();
  country = String(country || 'ALL').trim().toUpperCase();
  pageId = String(pageId || '').replace(/\D/g, '');   // numeric FB page id only (page-scoped scan)
  if (!brand && !pageId) { const e = new Error('Missing brand.'); e.status = 400; throw e; }
  if (!TOKEN) { const e = new Error('Ads provider not configured — set APIFY_TOKEN in Railway.'); e.status = 503; throw e; }

  const key = brand.toLowerCase() + '|' + country + (pageId ? '|p:' + pageId : '');
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < TTL) return { ...hit.data, cached: true };
  // cacheOnly: never trigger a live scrape (used by the chat) — return empty on a miss.
  if (cacheOnly) return { brand, country, count: 0, active: 0, platforms: [], newest: '', ads: [], cacheMiss: true };

  // PAGE-SCOPED scan pulls one confirmed brand page's ads directly (no keyword flood);
  // otherwise a keyword search by brand name.
  const searchUrl = pageId
    ? ('https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=' + encodeURIComponent(country) + '&view_all_page_id=' + pageId + '&search_type=page&media_type=all')
    : ('https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=' + encodeURIComponent(country) + '&q=' + encodeURIComponent(brand) + '&media_type=all');

  // Covers the common input shapes across Meta Ad Library actors — extra fields are ignored.
  // Meta returns matches in a NON-recency order, so a low cap silently drops the NEWEST ads for
  // heavy advertisers (Seranova runs 500+ persona advertorials — at 100 our newest lagged ~2 weeks
  // behind their real latest launch). 500 catches current newest; you only pay for results a brand
  // actually has, so light advertisers are unaffected. ADS_COUNT env can tune it down for cost.
  const ADS_N = Number(process.env.ADS_COUNT) || 500;
  const input = {
    urls: [{ url: searchUrl }],
    startUrls: [{ url: searchUrl }],
    searchTerms: pageId ? [] : [brand],
    count: ADS_N,
    maxItems: ADS_N,
    country,
    activeStatus: pageId ? 'all' : 'active',
    scrapePageAds: true,
    ...(pageId ? { pageId, pageIds: [pageId] } : {}),   // some actors take the page id directly
  };

  const endpoint =
    'https://api.apify.com/v2/acts/' + ACTOR +
    '/run-sync-get-dataset-items?token=' + encodeURIComponent(TOKEN) + '&timeout=300';

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    const e = new Error('Apify returned ' + res.status + '. ' + t.slice(0, 160));
    e.status = 502; throw e;
  }
  const items = await res.json();
  const data = await normalize(Array.isArray(items) ? items : [], brand, country, host, debug);
  cache.set(key, { at: Date.now(), data });
  return data;
}

function isTpl(s) { return !s || /\{\{[^}]*\}\}/.test(String(s)); }      // e.g. "{{product.brand}}"
function clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
function cardMedia(c) { return c.original_image_url || c.resized_image_url || c.video_preview_image_url || ''; }

// Keyword search in the Meta Ad Library drags in unrelated advertisers (e.g. a scooter
// brand surfacing under "oodie"). Keep only ads that actually belong to THIS brand —
// where a distinctive brand word appears in the page name, landing domain, or copy.
const BRAND_STOP = new Set(['the', 'and', 'for', 'shop', 'store', 'official', 'ltd', 'inc', 'llc', 'brand', 'online', 'buy', 'get', 'app', 'mobility', 'cosmetics', 'beauty', 'skincare', 'skin', 'care', 'fashion', 'clothing', 'apparel', 'wear', 'home', 'studio', 'company', 'group', 'global', 'world', 'collective']);
function brandTokens(brand) {
  return [...new Set(String(brand || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !BRAND_STOP.has(w)))];
}
// The set of strings that identify the brand: its distinctive name words, PLUS the
// whole name with separators removed (so "The Oodie" → "theoodie", which is how it
// appears in its own domain theoodie.com and page name).
function brandKeys(brand) {
  const keys = new Set(brandTokens(brand));
  const full = String(brand || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (full.length >= 4) keys.add(full);
  return keys;
}
// Split a name/domain into lowercased alphanumeric words. Domains break on dots AND
// hyphens ("super-hoodie.com" → super, hoodie, com), so a short key like "oodie" can
// never silently match inside "hoodie"/"foodie".
function wordsOf(s) { return String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean); }
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
    const resp = await aiClient().messages.create({ model: BRAND_MATCH_MODEL, max_tokens: 1000, system, messages: [{ role: 'user', content: rows }] });
    const txt = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim().replace(/^```(?:json)?|```$/g, '').trim();
    const parsed = JSON.parse(txt);
    const arr = Array.isArray(parsed.v) ? parsed.v : [];
    if (!arr.length) throw new Error('no verdicts');
    ask.forEach((d, idx) => {
      const hitv = arr.find((x) => Number(x.i) === idx + 1);
      const val = hitv ? !!hitv.same : true;   // keep if the model skipped a row
      out.set(d.id, val);
      _verdict.set(brand.toLowerCase() + '|' + d.advertiser.toLowerCase() + '|' + d.domain.toLowerCase(), { at: Date.now(), val });
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
  // Precision first (founder rule: NEVER show a random business — better to miss a brand ad
  // than show a different company's). When we know the brand's domain, keep ONLY its own-domain
  // ads, its own-page ads, and AI-confirmed ones — bare brand-NAME matching is disabled (it's
  // what let "brodo.ma"/"BRODO Footwear" through). Name matching only fills in when we have NO
  // domain to anchor on (fail-open so a domain-less brand isn't blanked).
  const stringKeep = (a) => onOwnDomain(a) || onBrandPage(a) || (hostDom ? false : (!keys.size ? true : adMatchesBrand(a, keys)));
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
    return ads.filter((a) => { if (onOwnDomain(a) || onBrandPage(a)) return true; const v = verdict.get(idOf(a)); return v === undefined ? stringKeep(a) : v; });
  } catch (e) {
    // AI error → be CONSERVATIVE when we know the brand's domain: keep only its own-domain
    // ads + ads from its own pages (whole-word name matching is unreliable for a generic name
    // like "Brodo", which matches BRODO Footwear, brodo.ma, etc.). No known domain → names.
    return ads.filter((a) => hostDom ? (onOwnDomain(a) || onBrandPage(a)) : stringKeep(a));
  }
}

// De-duplicate ads — never show the same creative twice. Two ads are "the same" if
// they share an image URL, or have the same landing + format and identical/≥90%-similar
// copy (the Meta library returns the same creative under many ad IDs / placements).
function normDup(t) { return String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function dupToks(t) { return new Set(normDup(t).split(' ').filter(Boolean)); }
function jaccard(a, b) { if (!a.size || !b.size) return a.size === b.size ? 1 : 0; let i = 0; a.forEach((w) => { if (b.has(w)) i++; }); return i / (a.size + b.size - i); }
function dedupeAds(ads) {
  const kept = [], meta = [];
  for (const a of ads) {
    const t = normDup(a.text || a.title), tk = dupToks(a.text || a.title), dom = adDomain(a.landing), f = fmtOf(a);
    let dup = false;
    for (let i = 0; i < kept.length; i++) {
      if (a.image && a.image === kept[i].image) { dup = true; break; }                          // identical creative
      const m = meta[i];
      if (dom === m.dom && f === m.f && tk.size >= 4 && (t === m.t || jaccard(tk, m.tk) >= 0.9)) { dup = true; break; } // same copy + funnel + format
    }
    if (!dup) { kept.push(a); meta.push({ t, tk, dom, f }); }
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
    rawCount: ads.length,                                                   // items returned by the actor (after mapping, before brand-attribution)
    keptCount: unique.length,
    rawNewest: ads.map((a) => a.started).filter(Boolean).sort().slice(-1)[0] || '',
    rawJul: ads.filter((a) => String(a.started || '') >= '2026-07-01').map((a) => ({ started: a.started, page: a.page, land: adDomain(a.landing) })),
    rawPages: [...new Set(ads.map((a) => a.page))].slice(0, 40),
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
function adDomain(u) { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { return ''; } }
// A competitor's own host (e.g. "campbells.com" or "https://campbells.com/x") → bare domain.
function hostToDomain(h) { h = String(h || '').trim(); if (!h) return ''; return adDomain(/^https?:\/\//i.test(h) ? h : ('https://' + h)); }
function fmtOf(a) { return a.hasVideo ? 'video' : (a.format && /carousel/i.test(a.format) ? 'carousel' : 'image'); }

// A "landing" worth surfacing as a clickable funnel: a real, openable web page —
// NOT an app deep-link, link-shortener, social/click redirect or other non-page URL
// (those don't work when clicked and aren't real landing pages, e.g. cooltra.onelink.me).
const JUNK_LANDING = /(?:^|\.)(onelink\.me|app\.link|go\.link|smart\.link|adj\.st|bnc\.lt|branch\.io|page\.link|bit\.ly|tinyurl\.com|t\.co|lnk\.to|linktr\.ee|rebrand\.ly|ow\.ly|buff\.ly|cutt\.ly|fb\.me|m\.me|wa\.me|api\.whatsapp\.com|l\.facebook\.com|lm\.facebook\.com)$/i;
function isFunnelUrl(u) {
  if (!/^https?:\/\//i.test(String(u || ''))) return false;        // must be a real web URL
  const dom = adDomain(u);
  if (!dom || dom.indexOf('.') < 0 || /\s/.test(dom)) return false; // need a valid public domain
  if (/^(facebook|instagram|fb)\.com$/i.test(dom)) return false;    // points back to the platform, not a funnel
  return !JUNK_LANDING.test(dom);
}

export async function adsChanges(host, todayAds) {
  const today = todayAds || [];
  if (!host) return null;
  const recent = await recentSnapshots(host, 'ads', 6);
  const tStr = new Date().toISOString().slice(0, 10);
  const prevSnap = recent.find((s) => s.day !== tStr && s.data && Array.isArray(s.data.ads) && s.data.ads.length);
  const prev = (prevSnap && prevSnap.data.ads) || [];
  // No comparable prior capture (first run, or the previous scan was much shallower — e.g. right
  // after we raised the scrape cap) → treat as baseline: don't flag the whole diff, which would be
  // a false BURST of previously-uncaptured OLD ads. BUT an ad that genuinely LAUNCHED in the last
  // few days is new regardless of capture depth, so still surface those (not in prev, started recently).
  if (!prev.length || prev.length < today.length * 0.6) {
    const prevIds0 = new Set(prev.map(adKey));
    const freshNew = today.filter((a) => !prevIds0.has(adKey(a)) && startedRecently(a.started, tStr, 4));
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
    pages: uniq(fresh.filter((a) => a.tags.some((t) => t.k === 'page')).map((a) => a.page)),
    formats: uniq(fresh.flatMap((a) => a.tags.filter((t) => t.k === 'format').map((t) => t.v))),
  };
  return { baseline: false, newCount: fresh.length, newAds: fresh.slice(0, 30), signals };
}
