// Ads intelligence — pulls a competitor's live ads from the Meta Ad Library
// via an Apify scraper actor (Apify handles the blocking/captchas for us).
//
// Set these in Railway → your backend service → Variables:
//   APIFY_TOKEN       (required) your Apify API token
//   APIFY_ADS_ACTOR   the actor you pick from the Apify Store, e.g. "curious_coder~facebook-ads-library-scraper"

import { recentSnapshots } from './snapshots.js';

const TOKEN = process.env.APIFY_TOKEN;
const ACTOR = process.env.APIFY_ADS_ACTOR || 'curious_coder~facebook-ads-library-scraper';
const TTL = 26 * 60 * 60 * 1000; // 26h — a daily 5am pre-warm keeps this hot so users never wait
const cache = new Map();

export async function fetchAds(brand, country, force, cacheOnly) {
  brand = String(brand || '').trim();
  country = String(country || 'ALL').trim().toUpperCase();
  if (!brand) { const e = new Error('Missing brand.'); e.status = 400; throw e; }
  if (!TOKEN) { const e = new Error('Ads provider not configured — set APIFY_TOKEN in Railway.'); e.status = 503; throw e; }

  const key = brand.toLowerCase() + '|' + country;
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < TTL) return { ...hit.data, cached: true };
  // cacheOnly: never trigger a live scrape (used by the chat) — return empty on a miss.
  if (cacheOnly) return { brand, country, count: 0, active: 0, platforms: [], newest: '', ads: [], cacheMiss: true };

  const searchUrl =
    'https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=' +
    encodeURIComponent(country) + '&q=' + encodeURIComponent(brand) + '&media_type=all';

  // Covers the common input shapes across Meta Ad Library actors — extra fields are ignored.
  const ADS_N = Number(process.env.ADS_COUNT) || 100;   // sweet spot: catches new ads (usually recent) at ~$2.25/mo/brand; ADS_COUNT env overrides
  const input = {
    urls: [{ url: searchUrl }],
    startUrls: [{ url: searchUrl }],
    searchTerms: [brand],
    count: ADS_N,
    maxItems: ADS_N,
    country,
    activeStatus: 'active',
    scrapePageAds: true,
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
  const data = normalize(Array.isArray(items) ? items : [], brand, country);
  cache.set(key, { at: Date.now(), data });
  return data;
}

function isTpl(s) { return !s || /\{\{[^}]*\}\}/.test(String(s)); }      // e.g. "{{product.brand}}"
function clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
function cardMedia(c) { return c.original_image_url || c.resized_image_url || c.video_preview_image_url || ''; }

// Map the Facebook Ad Library actor's items to a clean, display-ready shape.
// Many eComm ads are dynamic catalog ads whose body is a "{{product.brand}}"
// template — the real copy and creative then live in the per-product `cards` array.
function normalize(items, brand, country) {
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
      platforms,
      format: snap.display_format || (cards.length > 1 ? 'CAROUSEL' : 'IMAGE'),
      cta: snap.cta_text || '',
      landing: snap.link_url || (cards[0] && cards[0].link_url) || '',
      started: String(it.start_date_formatted || it.start_date || '').split(' ')[0],
      active: it.is_active !== false,
      link: it.ad_library_url || (it.ad_archive_id ? 'https://www.facebook.com/ads/library/?id=' + it.ad_archive_id : ''),
    };
  }).filter((a) => a.text || a.image);

  const platforms = [...new Set(ads.flatMap((a) => a.platforms))];
  const newest = ads.map((a) => a.started).filter(Boolean).sort().slice(-1)[0] || '';
  return {
    brand,
    country,
    count: items.length,
    active: ads.filter((a) => a.active).length,
    platforms,
    newest,
    ads: ads.slice(0, 300),   // keep the full set for day-over-day "what's new" diffing
  };
}

// ── "What's new" detection — compare today's ads to the most recent earlier
// capture and surface ONLY the new ones, tagged by why they're notable
// (new landing page / domain, new Facebook page, new creative format). ──
function adKey(a) { return a.id || a.link || a.image || ((a.page || '') + '|' + String(a.text || '').slice(0, 40)); }
function adDomain(u) { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { return ''; } }
function fmtOf(a) { return a.hasVideo ? 'video' : (a.format && /carousel/i.test(a.format) ? 'carousel' : 'image'); }

export async function adsChanges(host, todayAds) {
  const today = todayAds || [];
  if (!host) return null;
  const recent = await recentSnapshots(host, 'ads', 6);
  const tStr = new Date().toISOString().slice(0, 10);
  const prevSnap = recent.find((s) => s.day !== tStr && s.data && Array.isArray(s.data.ads) && s.data.ads.length);
  const prev = (prevSnap && prevSnap.data.ads) || [];
  // No comparable prior capture (first run, or the previous scan was much shallower) → baseline only.
  if (!prev.length || prev.length < today.length * 0.6) {
    return { baseline: true, newCount: 0, newAds: [], signals: { landings: [], pages: [], formats: [] } };
  }
  const prevIds = new Set(prev.map(adKey));
  const prevLand = new Set(prev.map((a) => adDomain(a.landing)).filter(Boolean));
  const prevPages = new Set(prev.map((a) => String(a.page || '').toLowerCase()).filter(Boolean));
  const prevFmts = new Set(prev.map(fmtOf));
  const fresh = [];
  for (const a of today) {
    if (prevIds.has(adKey(a))) continue;
    const tags = [];
    const dom = adDomain(a.landing);
    if (dom && !prevLand.has(dom)) tags.push({ k: 'landing', v: dom });
    if (a.page && !prevPages.has(String(a.page).toLowerCase())) tags.push({ k: 'page', v: a.page });
    const f = fmtOf(a);
    if (!prevFmts.has(f)) tags.push({ k: 'format', v: f });
    fresh.push({ ...a, tags });
  }
  const uniq = (arr) => [...new Set(arr)];
  const signals = {
    landings: uniq(fresh.flatMap((a) => a.tags.filter((t) => t.k === 'landing').map((t) => t.v))),
    pages: uniq(fresh.filter((a) => a.tags.some((t) => t.k === 'page')).map((a) => a.page)),
    formats: uniq(fresh.flatMap((a) => a.tags.filter((t) => t.k === 'format').map((t) => t.v))),
  };
  return { baseline: false, newCount: fresh.length, newAds: fresh.slice(0, 30), signals };
}
