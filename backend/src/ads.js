// Ads intelligence — pulls a competitor's live ads from the Meta Ad Library
// via an Apify scraper actor (Apify handles the blocking/captchas for us).
//
// Set these in Railway → your backend service → Variables:
//   APIFY_TOKEN       (required) your Apify API token
//   APIFY_ADS_ACTOR   the actor you pick from the Apify Store, e.g. "curious_coder~facebook-ads-library-scraper"

const TOKEN = process.env.APIFY_TOKEN;
const ACTOR = process.env.APIFY_ADS_ACTOR || 'curious_coder~facebook-ads-library-scraper';
const TTL = 6 * 60 * 60 * 1000; // cache 6h so we don't re-scrape (and re-pay) on every view
const cache = new Map();

export async function fetchAds(brand, country) {
  brand = String(brand || '').trim();
  country = String(country || 'ALL').trim().toUpperCase();
  if (!brand) { const e = new Error('Missing brand.'); e.status = 400; throw e; }
  if (!TOKEN) { const e = new Error('Ads provider not configured — set APIFY_TOKEN in Railway.'); e.status = 503; throw e; }

  const key = brand.toLowerCase() + '|' + country;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return { ...hit.data, cached: true };

  const searchUrl =
    'https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=' +
    encodeURIComponent(country) + '&q=' + encodeURIComponent(brand) + '&media_type=all';

  // Covers the common input shapes across Meta Ad Library actors — extra fields are ignored.
  const input = {
    urls: [{ url: searchUrl }],
    startUrls: [{ url: searchUrl }],
    searchTerms: [brand],
    count: 24,
    maxItems: 24,
    country,
    activeStatus: 'active',
    scrapePageAds: true,
  };

  const endpoint =
    'https://api.apify.com/v2/acts/' + ACTOR +
    '/run-sync-get-dataset-items?token=' + encodeURIComponent(TOKEN) + '&timeout=120';

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
  const data = normalize(Array.isArray(items) ? items : []);
  cache.set(key, { at: Date.now(), data });
  return data;
}

function get(o, path) { return path.split('.').reduce((a, k) => (a == null ? a : a[k]), o); }
function pick(o, keys) { for (const k of keys) { const v = get(o, k); if (v) return v; } return ''; }

// Map an actor's items to a clean shape. Field names vary by actor, so we probe several.
function normalize(items) {
  const ads = items.map((it) => {
    const snap = it.snapshot || {};
    return {
      text:
        pick(it, ['adText', 'body', 'primaryText', 'snapshot.body.text', 'ad_creative_body']) ||
        (snap.body && snap.body.text) || '',
      image:
        pick(it, ['imageUrl', 'image', 'thumbnailUrl']) ||
        (snap.images && snap.images[0] && (snap.images[0].original_image_url || snap.images[0].resized_image_url)) ||
        (snap.videos && snap.videos[0] && snap.videos[0].video_preview_image_url) || '',
      page: pick(it, ['pageName', 'page_name', 'snapshot.page_name', 'advertiserName']) || '',
      platform: String(pick(it, ['publisherPlatform', 'platforms']) || 'Meta'),
      started: pick(it, ['startDate', 'ad_delivery_start_time', 'startedRunning', 'adDeliveryStartTime']) || '',
      link:
        pick(it, ['url', 'adLibraryUrl']) ||
        (it.adArchiveID ? 'https://www.facebook.com/ads/library/?id=' + it.adArchiveID : '') ||
        (it.ad_archive_id ? 'https://www.facebook.com/ads/library/?id=' + it.ad_archive_id : ''),
    };
  }).filter((a) => a.text || a.image);
  return { count: items.length, ads: ads.slice(0, 12) };
}
