// Organic social intelligence — a competitor's recent posts on Instagram,
// TikTok and Facebook, via Apify scraper actors.
//
//   GET /api/social?platform=instagram&handle=the_oodie
//   GET /api/social?platform=tiktok&host=theoodie.com   (handle auto-resolved from the site)
//
// Uses the same APIFY_TOKEN as the ads endpoint. Actors are overridable in Railway:
//   APIFY_IG_ACTOR  (default apify~instagram-scraper)
//   APIFY_TT_ACTOR  (default clockworks~tiktok-scraper)
//   APIFY_FB_ACTOR  (default apify~facebook-posts-scraper)

const TOKEN = process.env.APIFY_TOKEN;
const TTL = 6 * 60 * 60 * 1000; // 6h cache (scrapes are slow + cost credits)
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

const cache = new Map();
const handleCache = new Map();

const SHORT = { instagram: 'ig', tiktok: 'tt', facebook: 'fb' };
const ACTORS = {
  instagram: process.env.APIFY_IG_ACTOR || 'apify~instagram-scraper',
  tiktok: process.env.APIFY_TT_ACTOR || 'clockworks~tiktok-scraper',
  facebook: process.env.APIFY_FB_ACTOR || 'apify~facebook-posts-scraper',
};
const INPUT = {
  instagram: (h) => ({ directUrls: ['https://www.instagram.com/' + h + '/'], resultsType: 'posts', resultsLimit: 9, addParentData: false }),
  tiktok: (h) => ({ profiles: [h], resultsPerPage: 9, shouldDownloadVideos: false, shouldDownloadCovers: false, shouldDownloadSubtitles: false }),
  facebook: (h) => ({ startUrls: [{ url: 'https://www.facebook.com/' + h }], resultsLimit: 9 }),
};

function clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

async function runActor(actor, input) {
  const ep = 'https://api.apify.com/v2/acts/' + actor +
    '/run-sync-get-dataset-items?token=' + encodeURIComponent(TOKEN) + '&timeout=150';
  const res = await fetch(ep, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    const e = new Error(actor + ' returned ' + res.status + '. ' + t.slice(0, 120));
    e.status = 502; throw e;
  }
  const j = await res.json();
  return Array.isArray(j) ? j : [];
}

// Pull a brand's social handles straight from its website footer (cached).
async function resolveHandles(host) {
  const key = host.toLowerCase();
  const hit = handleCache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.h;
  const h = {};
  try {
    const r = await fetch('https://' + host + '/', { headers: { 'User-Agent': UA } });
    const html = await r.text();
    const bad = /^(p|reel|reels|explore|accounts|sharer|share|tr|dialog|plugins|profile\.php|policies|help|login|pages|groups|events|watch|story\.php|permalink\.php|home\.php)$/i;
    const ig = html.match(/instagram\.com\/([A-Za-z0-9_.]{2,40})/i);
    const tt = html.match(/tiktok\.com\/@([A-Za-z0-9_.]{2,40})/i);
    const fb = html.match(/facebook\.com\/([A-Za-z0-9_.]{2,40})/i);
    if (ig && !bad.test(ig[1])) h.ig = ig[1];
    if (tt) h.tt = tt[1];
    if (fb && !bad.test(fb[1])) h.fb = fb[1];
  } catch (e) { /* leave handles empty on failure */ }
  handleCache.set(key, { at: Date.now(), h });
  return h;
}

function normIG(items) {
  return items.map((p) => ({
    platform: 'instagram',
    text: clean(p.caption),
    image: p.displayUrl || (Array.isArray(p.images) && p.images[0]) || '',
    likes: (typeof p.likesCount === 'number' && p.likesCount >= 0) ? p.likesCount : null,
    comments: (typeof p.commentsCount === 'number' && p.commentsCount >= 0) ? p.commentsCount : null,
    views: p.videoPlayCount || p.videoViewCount || null,
    kind: p.type === 'Video' ? 'Reel' : (p.type === 'Sidecar' ? 'Carousel' : 'Post'),
    date: p.timestamp || '',
    url: p.url || '',
  })).filter((p) => p.image || p.text);
}
function normTT(items) {
  return items.map((p) => {
    const vm = p.videoMeta || {};
    return {
      platform: 'tiktok',
      text: clean(p.text),
      image: vm.coverUrl || vm.originalCoverUrl || (Array.isArray(p.mediaUrls) && p.mediaUrls[0]) || '',
      likes: typeof p.diggCount === 'number' ? p.diggCount : null,
      comments: typeof p.commentCount === 'number' ? p.commentCount : null,
      views: typeof p.playCount === 'number' ? p.playCount : null,
      shares: typeof p.shareCount === 'number' ? p.shareCount : null,
      kind: 'Video',
      date: p.createTimeISO || '',
      url: p.webVideoUrl || '',
    };
  }).filter((p) => p.image || p.text);
}
function fbImage(p) {
  const m = p.media;
  if (Array.isArray(m)) {
    for (const x of m) {
      const o = x || {};
      const u = (o.photo_image && o.photo_image.uri) || (o.image && o.image.uri) ||
        o.thumbnail || (/\.(jpg|jpeg|png|webp)/i.test(o.url || '') ? o.url : '');
      if (u) return u;
    }
  }
  return p.full_picture || p.thumbnail || '';
}
function normFB(items) {
  return items.map((p) => ({
    platform: 'facebook',
    text: clean(p.text),
    image: fbImage(p),
    likes: typeof p.likes === 'number' ? p.likes : (p.topReactionsCount || null),
    comments: typeof p.comments === 'number' ? p.comments : null,
    shares: typeof p.shares === 'number' ? p.shares : null,
    kind: /\/reel\//.test(p.url || '') ? 'Reel' : 'Post',
    date: p.time || p.timestamp || '',
    url: p.topLevelUrl || p.url || '',
  })).filter((p) => p.image || p.text);
}
const NORM = { instagram: normIG, tiktok: normTT, facebook: normFB };

function summarize(platform, posts) {
  if (!posts.length) return null;
  const metric = platform === 'tiktok' ? 'views' : 'likes';
  const top = posts.slice().sort((a, b) => (b[metric] || 0) - (a[metric] || 0))[0];
  const dates = posts.map((p) => p.date).filter(Boolean).sort();
  return {
    count: posts.length,
    metric,
    topValue: top ? top[metric] : null,
    topUrl: top ? top.url : '',
    latest: dates.length ? dates[dates.length - 1] : '',
    earliest: dates.length ? dates[0] : '',
  };
}

export async function fetchSocial(platform, handle, host) {
  if (!TOKEN) { const e = new Error('Social provider not configured — set APIFY_TOKEN in Railway.'); e.status = 503; throw e; }
  platform = String(platform || '').toLowerCase();
  if (!ACTORS[platform]) { const e = new Error('Unknown platform.'); e.status = 400; throw e; }
  handle = String(handle || '').trim().replace(/^@/, '');
  host = String(host || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');

  if (!handle && host) { const h = await resolveHandles(host); handle = h[SHORT[platform]] || ''; }
  if (!handle) return { platform, handle: null, posts: [], summary: null };

  const key = platform + '|' + handle.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return { ...hit.data, cached: true };

  const items = await runActor(ACTORS[platform], INPUT[platform](handle));
  const posts = NORM[platform](items).slice(0, 9);
  const data = { platform, handle, posts, summary: summarize(platform, posts) };
  cache.set(key, { at: Date.now(), data });
  return data;
}
