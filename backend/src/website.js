// Website intelligence — captures a daily fingerprint of a competitor's storefront
// (a products.json summary + a screenshot) so we can show, day over day, exactly
// what changed: prices moved, a sale started, products added/removed — with a
// before/after screenshot slider in the app.
//
//   GET /api/website-compare?host=theoodie.com&url=https://www.theoodie.com
//     -> { after:{day,shot,summary}, before:{day,shot,summary}|null, changes:[...] }

import { saveSnapshot, recentSnapshots, latestSnapshot, saveSnapshotDay } from './snapshots.js';
import { pool } from './db.js';
import Anthropic from '@anthropic-ai/sdk';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const BANNER_MODEL = process.env.BANNER_MODEL || 'claude-haiku-4-5';
let _bc;
function bannerClient() { if (!_bc) _bc = new Anthropic(); return _bc; }
const oneLine = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

function money(n) { n = Number(n); if (isNaN(n)) return '?'; return (Math.round(n * 100) / 100).toString(); }
function cleanHost(host) {
  return String(host || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '').toLowerCase();
}

// Fetch the homepage and reduce it to plain visible text (top slice only — banners/hero
// promos always sit near the top of the page).
async function fetchHomeText(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
    if (!r.ok) return '';
    const html = await r.text();
    return html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z#0-9]+;/gi, ' ')
      .replace(/\s+/g, ' ').trim()
      .slice(0, 2500);
  } catch (e) { return ''; }
}

// Read the homepage's actual promo/banner headline (if any) — never inferred from
// numbers alone, so it quotes the real on-site copy ("4th of July Sale: 60% off…").
// Judgment call (is this text actually a live offer?), so an AI reads it rather than
// a keyword regex — same reasoning as the ad-attribution and landing-format fixes.
// A real banner is a SHORT headline. Vision/text models sometimes narrate a NON-answer
// instead of returning empty ("I don't see any active promotion… the page shows warranty
// info"). Coerce those — and anything too long to be a headline — to '' so the banner
// field is always either a crisp promo line or nothing (never a paragraph of prose).
// The screenshot service (ScreenshotOne / WordPress mShots) sometimes returns an ERROR image
// instead of the storefront — a "local rate limited" / "try again" placeholder. The vision
// banner reader then reads that text and it gets stored as the banner (Seranova showed
// "local_rate_limited" for days). This detects such a read so we reject it AND discard the
// error screenshot itself.
export function bannerLooksLikeError(s) {
  return /\berrorpage\b|rate.?limit|local[_\s-]?rate|_limited\b|too many requests|\b429\b|screenshot(one)?|mshots|try again|temporarily unavailable|\berror\b|forbidden|blocked/i.test(String(s || ''));
}
function cleanBanner(s) {
  const t = oneLine(s || '').replace(/^["'\s]+|["'\s.]+$/g, '');
  if (!t) return '';
  if (bannerLooksLikeError(t)) return '';   // a screenshot-service error page, not a promo
  if (/^(i (don'?t|do not|can'?t|cannot)\b|there (is|are) no\b|no (active|visible|current)?\s*(promotion|promo|sale|offer|banner)|none\b|n\/?a\b|empty\b|not\b|unable\b)/i.test(t)) return '';
  if (t.split(/\s+/).length > 16 || t.length > 120) return '';   // longer than a headline → it's an explanation, not a banner
  return t.slice(0, 160);
}

async function bannerRawFromText(homeText) {
  if (!process.env.ANTHROPIC_API_KEY || !homeText) return '';
  try {
    const system =
      'You are shown the top of a storefront homepage\'s visible text. If there is an ACTIVE promotion, sale, or offer being advertised (a banner, hero headline, or announcement bar — e.g. a percent-off sale, a free-gift offer, a discount code), state it in <=14 words, plain text. ' +
      'If the promotion has a NAMED OCCASION (e.g. "4th of July Sale", "Black Friday", "Anniversary Sale", "Back to School") — always keep that exact name in what you return; it is the most useful part (it tells us WHEN they run their biggest pushes), so never drop it in favour of just the discount percentage. ' +
      'If there is clearly no active promotion in the text, return an empty string. Only report what is actually stated — never guess or invent one.';
    const resp = await bannerClient().messages.create({ model: BANNER_MODEL, max_tokens: 60, system, messages: [{ role: 'user', content: homeText }] });
    return (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  } catch (e) { return ''; }
}

// Read the promo banner from the SCREENSHOT (what's actually DISPLAYED) rather than the raw
// HTML — a plain fetch runs no JS, so it can pick up an UPCOMING banner sitting in the page
// code behind a countdown and report a sale switch a DAY before it's visibly shown. Reading
// the rendered screenshot keeps the banner in step with what users (and our before/after
// image) actually see. Falls back to the HTML-text read only if there's no shot / vision errors.
// Returns the RAW model text (uncleaned) so callers can also detect a service-error screenshot.
async function bannerRawFromShot(shot, homeText) {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(String(shot || ''));
  if (process.env.ANTHROPIC_API_KEY && m) {
    try {
      const system =
        'You are shown a screenshot that SHOULD be a storefront homepage. FIRST check it is actually a webpage: if it is instead an error/placeholder image — a rate-limit or error message (e.g. "too many requests", "local_rate_limited"), a service logo on an empty frame, a browser/CDN error, or a blank/near-blank page with no real page content — reply exactly ERRORPAGE and nothing else. ' +
        'Otherwise: if an ACTIVE promotion/sale/offer is VISIBLY displayed (an announcement bar, banner or hero headline — e.g. a %-off sale, free-gift, or discount code), state it in <=14 words, plain text, keeping any NAMED OCCASION exactly ("4th of July Sale", "Black Friday", "Summer Sale"). ' +
        'If NO promotion is visibly shown, return an empty string. Report ONLY what is actually VISIBLE in the image — never guess, and never report a banner that is not shown.';
      const resp = await bannerClient().messages.create({ model: BANNER_MODEL, max_tokens: 60, system, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } }, { type: 'text', text: 'What promotion is visibly displayed at the top of this storefront?' }] }] });
      return (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    } catch (e) { /* vision error → fall back to the HTML-text read */ }
  }
  return bannerRawFromText(homeText);
}

// Read the promo banner AND flag whether the "screenshot" was actually a service error page.
// Returns { banner, error }: banner = cleaned promo (or ''), error = true when the shot was a
// rate-limit / error image (so the caller can discard that bad screenshot).
export async function readBanner(shot, homeText) {
  const raw = await bannerRawFromShot(shot, homeText);
  return { banner: cleanBanner(raw), error: bannerLooksLikeError(raw) };
}
// Back-compat: cleaned banner only.
export async function siteBannerFromShot(shot, homeText) { return (await readBanner(shot, homeText)).banner; }

// A small, diff-friendly summary of the storefront, from Shopify's products.json
// (works for the many DTC brands on Shopify; returns null otherwise — the
// before/after screenshot still works without it).
export async function siteSummary(host) {
  const base = 'https://' + cleanHost(host);
  try {
    const r = await fetch(base + '/products.json?limit=250', { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!r.ok) return null;
    const j = await r.json();
    const products = Array.isArray(j.products) ? j.products : [];
    if (!products.length) return null;
    let onSale = 0, min = Infinity, max = 0;
    const items = {};
    for (const p of products) {
      let pPrice = Infinity, pWas = null, sale = false, avail = false;
      for (const v of (p.variants || [])) {
        const price = parseFloat(v.price);
        const was = v.compare_at_price ? parseFloat(v.compare_at_price) : null;
        if (!isNaN(price)) { pPrice = Math.min(pPrice, price); min = Math.min(min, price); max = Math.max(max, price); }
        if (was && !isNaN(was) && was > price) { sale = true; if (pWas == null || was > pWas) pWas = was; }
        if (v.available) avail = true;
      }
      if (sale) onSale++;
      if (p.handle && pPrice !== Infinity && Object.keys(items).length < 80) {
        items[p.handle] = { title: p.title, price: pPrice, was: pWas, sale, avail };
      }
    }
    return { products: products.length, onSale, min: min === Infinity ? null : min, max: max || null, items };
  } catch (e) { return null; }
}

// One above-the-fold screenshot as a base64 data URL (so before/after frames are
// stored and pixel-aligned). Needs SCREENSHOTONE_KEY; returns null without it.
export async function siteShot(url) {
  const key = process.env.SCREENSHOTONE_KEY;
  if (!key || !/^https?:\/\//i.test(String(url || ''))) return null;
  const base = 'https://api.screenshotone.com/take?access_key=' + encodeURIComponent(key) +
    '&url=' + encodeURIComponent(url) +
    '&format=jpg&image_quality=72&viewport_width=1280&viewport_height=800' +
    '&block_cookie_banners=true&block_banners_by_heuristics=true&block_ads=true&block_chats=true' +
    // NO caching. The daily capture must be a FRESH frame that matches the banner text read
    // alongside it, or the picture lags the read by a day (that's the sale-switch-on-the-
    // wrong-day bug). Do NOT "fix" staleness with a short cache_ttl: ScreenshotOne's minimum
    // is 14400s, so a smaller value is rejected outright and siteShot silently returns null —
    // which is exactly what killed every screenshot 14–17 Jul. We capture once a day per
    // brand, so there is nothing to gain from caching anyway.
    '&cache=false';
  // Prefer network-idle so Cloudflare-style JS challenges (e.g. drinkag1.com) clear before
  // the frame is taken. But a storefront with a chat widget or polling analytics NEVER goes
  // idle, so that wait times out every time (thetallowedtruth.com failed ~2 of 3 attempts) —
  // fall back to the laxer 'load' rather than lose the screenshot entirely.
  for (const wait of ['networkidle2', 'load']) {
    try {
      const r = await fetch(base + '&wait_until=' + wait + '&delay=3&navigation_timeout=25', { headers: { 'User-Agent': UA } });
      if (!r.ok) { console.warn('siteShot ' + cleanHost(url) + ' [' + wait + ']: screenshotone ' + r.status + ' — ' + (await r.text().catch(() => '')).slice(0, 160)); continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 1200) continue;   // too small to be a real screenshot
      return 'data:image/jpeg;base64,' + buf.toString('base64');
    } catch (e) { /* try the laxer wait */ }
  }
  // Both waits failed. One more targeted attempt before switching engines: shoot the CANONICAL
  // url (following the site's own redirect — currentbody.com 301s to www.currentbody.com) with a
  // longer settle delay, which is what Cloudflare-challenged storefronts need. The redirect hop
  // plus challenge inside a short window is exactly where the first attempts die.
  try {
    const probe = await fetch(url, { method: 'HEAD', redirect: 'follow', headers: { 'User-Agent': UA } }).catch(() => null);
    const finalUrl = probe && probe.url && probe.url !== url ? probe.url : null;
    if (finalUrl) {
      const b2 = 'https://api.screenshotone.com/take?access_key=' + encodeURIComponent(key) +
        '&url=' + encodeURIComponent(finalUrl) +
        '&format=jpg&image_quality=72&viewport_width=1280&viewport_height=800' +
        '&block_cookie_banners=true&block_banners_by_heuristics=true&block_ads=true&block_chats=true&cache=false';
      const r = await fetch(b2 + '&wait_until=load&delay=8&navigation_timeout=40', { headers: { 'User-Agent': UA } });
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length >= 1200) return 'data:image/jpeg;base64,' + buf.toString('base64');
      } else { console.warn('siteShot ' + cleanHost(url) + ' [canonical retry]: screenshotone ' + r.status); }
    }
  } catch (e) { /* fall through to mShots */ }
  // ScreenshotOne couldn't render it — some storefronts 502 it outright (seranova.com, 18 Jul)
  // even though the site loads fine in a real browser. Fall back to a DIFFERENT engine
  // (WordPress mShots) so the storefront still gets a picture instead of a blank panel.
  const fb = await mshotsShot(url);
  if (fb) { console.warn('siteShot ' + cleanHost(url) + ': screenshotone failed on all waits — used mShots fallback'); return fb; }
  return null;
}

// Fallback screenshot engine. mShots renders ASYNCHRONOUSLY: the first hits return a small
// "loading" GIF placeholder, then the real JPEG once generated — so poll, and reject the GIF.
export async function mshotsShot(url) {
  if (!/^https?:\/\//i.test(String(url || ''))) return null;
  const target = 'https://s.wordpress.com/mshots/v1/' + encodeURIComponent(url) + '?w=1280';
  for (let i = 0; i < 6; i++) {
    try {
      const r = await fetch(target, { headers: { 'User-Agent': UA }, redirect: 'follow' });
      if (r.ok) {
        const ct = (r.headers.get('content-type') || '').toLowerCase();
        const buf = Buffer.from(await r.arrayBuffer());
        if (/image\/(jpeg|png)/.test(ct) && buf.length > 3000) {   // a real capture, not the GIF placeholder
          return 'data:' + (/png/.test(ct) ? 'image/png' : 'image/jpeg') + ';base64,' + buf.toString('base64');
        }
      }
    } catch (e) { /* retry */ }
    if (i < 5) await new Promise((r) => setTimeout(r, 4000));   // give mShots time to render
  }
  return null;
}

// Capture today's fingerprint and persist it (one row per host/day; upserts).
// CHANGE-GATED screenshots (founder, 20 Jul: "only post a new screenshot when the change occurs
// — the same screenshot day over day doesn't make sense"). Cheap signals decide whether to spend
// a screenshot: the product-feed diff, an HTML banner change, or a 7-day heartbeat (so every
// brand still gets at least one fresh frame a week, catching pure-visual redesigns). On quiet
// days we store `shotFrom: <day>` — a dated pointer to the last real frame — which also cuts
// ScreenshotOne usage ~5-10× (likely back inside the free tier) and DB growth likewise.
export async function captureWebsite(host, url) {
  const u = url || ('https://' + cleanHost(host));
  const today = new Date().toISOString().slice(0, 10);
  const [summary, homeText, prev] = await Promise.all([
    siteSummary(host), fetchHomeText(u), latestSnapshot(host, 'website').catch(() => null),
  ]);

  const prevDay = prev ? String(prev.__day || '').slice(0, 10) : '';
  const sameDayFrame = (prev && prevDay === today && prev.shot && !bannerLooksLikeError(prev.banner)) ? prev.shot : null;
  // When did we last take a REAL frame? (prev may itself be a pointer row)
  const lastFrameDay = prev ? (prev.shot ? prevDay : String(prev.shotFrom || '')) : '';
  const frameAgeDays = lastFrameDay ? Math.round((Date.parse(today) - Date.parse(lastFrameDay)) / 864e5) : Infinity;
  // A same-day row flagged shotStale means a CHANGE day whose fresh shot FAILED (services
  // refused) — the stored frame still shows the OLD state next to the NEW banner text
  // (Seranova 21 Jul: read "Summer Sale", frame "4th of July"). Keep trying until a real
  // frame lands; without this the pointer row reads as a quiet day and never re-shoots.
  const stalePending = !!(prev && prevDay === today && prev.shotStale);

  // HTML banner read — CHANGE SIGNAL only (cheap text model); the stored banner always comes
  // from a rendered screenshot. Only a NON-EMPTY differing read counts, so announcement-bar
  // rotation (the sale slide cycling out of the HTML slice) doesn't fire a shot every day.
  const bnorm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9%]+/g, ' ').trim();
  const htmlBanner = cleanBanner(await bannerRawFromText(homeText));
  const bannerChanged = !!htmlBanner && bnorm(htmlBanner) !== bnorm(prev && prev.banner);
  const summaryChanged = !!(prev && prev.summary && summary && diffWebsite(prev.summary, summary).length) || (!!summary !== !!(prev && prev.summary));
  const changed = !prev || !lastFrameDay || frameAgeDays >= 7 || summaryChanged || bannerChanged || stalePending;

  if (!changed) {
    // Quiet: keep today's own frame if we have one, else a dated pointer to the last real
    // frame — no screenshot spent, and the UI says "unchanged since <day>" honestly.
    const data = sameDayFrame
      ? { summary, shot: sameDayFrame, banner: (prev && prev.banner) || '', capturedAt: new Date().toISOString() }
      : { summary, shot: null, shotFrom: lastFrameDay, banner: (prev && prev.banner) || '', capturedAt: new Date().toISOString() };
    await saveSnapshot(host, 'website', data);
    return data;
  }

  // Something moved (or the weekly heartbeat is due) → spend a real screenshot, with the
  // error-image guard.
  let shot = await siteShot(u);
  let { banner, error: shotIsError } = await readBanner(shot, homeText);
  if (shot && shotIsError) { shot = null; banner = await siteBannerFromShot(null, homeText); }
  if (!shot) {
    // Fresh shot failed → today's earlier good frame beats nothing; else a pointer to the last
    // real frame (never to today itself — that row is about to be overwritten). The
    // websiteCompare self-heal retries the capture later.
    const refDay = (lastFrameDay && lastFrameDay !== today) ? lastFrameDay : '';
    // shotStale marks "this pointer exists only because the shot FAILED on a change day" —
    // it keeps both the capture gate and the view-time self-heal retrying until a real
    // frame replaces it (a successful shot stores no flag, clearing it naturally).
    const data = sameDayFrame
      ? { summary, shot: sameDayFrame, banner: (prev && prev.banner) || banner || '', capturedAt: new Date().toISOString() }
      : { summary, shot: null, ...(refDay ? { shotFrom: refDay } : {}), banner, shotStale: true, capturedAt: new Date().toISOString() };
    await saveSnapshot(host, 'website', data);
    return data;
  }
  const data = { summary, shot, banner, capturedAt: new Date().toISOString() };
  await saveSnapshot(host, 'website', data);
  return data;
}

// Which specific products changed price (drop/rise) or are new — so we can
// screenshot exactly those pages. Prioritises drops + new (most interesting).
function changedHandles(a, b, cap) {
  const am = (a && a.items) || {}, bm = (b && b.items) || {}, out = [];
  for (const h in bm) {
    if (am[h] && am[h].price != null && bm[h].price != null && Math.abs(am[h].price - bm[h].price) >= 0.01) {
      out.push({ handle: h, title: bm[h].title || h, kind: bm[h].price < am[h].price ? 'drop' : 'rise', detail: money(am[h].price) + ' → ' + money(bm[h].price) });
    }
  }
  for (const h in bm) { if (!am[h]) out.push({ handle: h, title: bm[h].title || h, kind: 'new', detail: 'New product' + (bm[h].price != null ? ' · ' + money(bm[h].price) : '') }); }
  const pri = out.filter((c) => c.kind !== 'rise').concat(out.filter((c) => c.kind === 'rise'));
  return pri.slice(0, cap || 3);
}

// Daily capture, plus a screenshot of each product page that changed vs the
// previous capture (targeted "screenshot what changed").
export async function captureWebsiteFull(host, url) {
  const data = await captureWebsite(host, url);
  try {
    const recent = await recentSnapshots(host, 'website', 2);
    const prev = recent[1];
    if (prev && prev.data && prev.data.summary && data.summary) {
      const changed = changedHandles(prev.data.summary, data.summary, 3);
      for (const ch of changed) ch.shot = await siteShot('https://' + cleanHost(host) + '/products/' + ch.handle);
      data.changedShots = changed.filter((c) => c.shot);
      if (data.changedShots.length) await saveSnapshot(host, 'website', data);
    }
  } catch (e) { /* targeting is best-effort */ }
  return data;
}

// Human-readable list of what changed between two daily summaries.
export function diffWebsite(a, b) {
  if (!a || !b) return [];
  const out = [];
  // Sale STATE transition only (started / ended). A change of a few products in/out of the
  // discount (widened/narrowed) is churn, not a signal — the founder rejected raw
  // discounted-product counts (18 Jul), so we don't emit them or the count itself.
  const aSale = a.onSale || 0, bSale = b.onSale || 0;
  if (aSale === 0 && bSale > 0) out.push('Sale started — discounts now live on the catalogue');
  else if (aSale > 0 && bSale === 0) out.push('Sale ended — catalogue back to regular pricing');

  const am = a.items || {}, bm = b.items || {};
  let priceChanges = 0;
  for (const h in bm) {
    if (am[h] && am[h].price != null && bm[h].price != null && Math.abs(am[h].price - bm[h].price) >= 0.01) {
      if (priceChanges < 4) out.push('“' + (bm[h].title || h) + '”  ' + money(am[h].price) + ' → ' + money(bm[h].price));
      priceChanges++;
    }
  }
  if (priceChanges > 4) out.push('+' + (priceChanges - 4) + ' more price change' + (priceChanges - 4 > 1 ? 's' : ''));

  const added = Object.keys(bm).filter((h) => !am[h]);
  const removed = Object.keys(am).filter((h) => !bm[h]);
  if (added.length) out.push(added.length + ' new product' + (added.length > 1 ? 's' : '') + (added.length <= 2 ? ': “' + added.map((h) => bm[h].title || h).join('”, “') + '”' : ''));
  if (removed.length) out.push(removed.length + ' product' + (removed.length > 1 ? 's' : '') + ' removed');
  if (a.min != null && b.min != null && Math.abs(a.min - b.min) >= 0.01) out.push('Lowest price ' + money(a.min) + ' → ' + money(b.min));

  return out.slice(0, 7);
}

// The compare payload for the app. Ensures there's a fresh capture (so "after" is
// current), then diffs it against the most recent earlier day.
// `force` (admin only) re-captures now instead of waiting for the freshness window — each
// force is a real screenshot + banner read, so it stays gated.
// A screenshot we'd actually SHOW someone: present, not flagged as an error read, and bigger
// than the ~28KB service error placeholders (real above-the-fold storefront JPEGs run 100KB+).
// Display-selection only — nothing is ever deleted based on this.
function plausibleShot(s) {
  const d = s && s.data;
  return !!(d && d.shot && String(d.shot).length > 60000 && (d._shotOk || !bannerLooksLikeError(d.banner)));
}

// One-time history scrub (runs at boot, idempotent): error frames stored BEFORE the discard
// guard existed (rate-limit placeholders from the 18-20 Jul deploy storm) still sit in recent
// days. Each SUSPICIOUS frame (small, or error-flagged/empty banner) gets ONE vision check:
// confirmed error → shot nulled + error banner cleared (summaries/diffs untouched); actually
// fine → stamped _shotOk so it's never re-checked. After the first pass there's nothing left
// to check, so later boots cost a single SQL scan and no AI.
export async function scrubWebsiteHistory(days) {
  if (!process.env.DATABASE_URL) return { checked: 0, cleaned: 0 };
  let checked = 0, cleaned = 0, kept = 0;
  try {
    const r = await pool.query(
      `SELECT host, to_char(day,'YYYY-MM-DD') AS day, data FROM snapshots
       WHERE channel = 'website' AND day >= CURRENT_DATE - $1::int
         AND length(coalesce(data->>'shot','')) > 50 ORDER BY day DESC`, [days || 10]);
    for (const row of r.rows) {
      const d = row.data || {};
      const len = String(d.shot || '').length;
      const suspicious = !d._shotOk && (len < 60000 || bannerLooksLikeError(d.banner) || !d.banner);
      if (!suspicious) continue;
      checked++;
      const read = await readBanner(d.shot, '');
      if (read.error) {
        d.shot = null;
        if (bannerLooksLikeError(d.banner)) d.banner = '';
        cleaned++;
      } else {
        d._shotOk = 1;                                  // verified real — never re-check
        if (!d.banner && read.banner) d.banner = read.banner;   // bonus: recover the day's real banner
        kept++;
      }
      await saveSnapshotDay(row.host, 'website', row.day, d);
    }
    if (checked) console.log(`✓ website history scrub: ${checked} suspicious frame(s) vision-checked — ${cleaned} error frame(s) removed, ${kept} verified real`);
  } catch (e) { console.warn('scrubWebsiteHistory:', e.message); }
  return { checked, cleaned };
}
// Resolve change-gated `shotFrom` pointers in place: a quiet day carries the DAY of the last
// real frame instead of a copy of it — attach that frame's image so every consumer downstream
// (slider, fallback picks, plausibility checks) just sees a shot, plus the source day for
// honest "unchanged since X" labelling. Rows are this call's own query results — safe to mutate.
function resolveShotRefs(rows) {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  for (const r of rows) {
    const d = r.data;
    if (d && !d.shot && d.shotFrom) {
      const src = byDay.get(String(d.shotFrom));
      if (src && src.data && src.data.shot) d.shot = src.data.shot;
    }
  }
  return rows;
}
export async function websiteCompare(host, url, day, force) {
  if (!host) { const e = new Error('Missing host.'); e.status = 400; throw e; }
  const shape = (s) => s ? { day: s.day, capturedAt: (s.data && s.data.capturedAt) || null, shot: (s.data && s.data.shot) || null, shotFrom: (s.data && s.data.shotFrom) || null, summary: (s.data && s.data.summary) || null } : null;
  const mk = (after, before, extra) => ({
    host: cleanHost(host),
    after: shape(after), before: shape(before),
    changes: (before && after) ? diffWebsite(before.data && before.data.summary, after.data && after.data.summary) : [],
    changedShots: (after && after.data && after.data.changedShots) || [],
    ...extra,
  });

  // Historical view — the capture on `day` vs the most recent earlier capture (no live re-capture).
  if (day) {
    const recent = resolveShotRefs(await recentSnapshots(host, 'website', 40));   // sorted day DESC
    const before = recent.find((s) => s.day < day) || null;
    const out = mk(recent.find((s) => s.day === day) || null, before, { day });
    if (out.after && out.before && out.after.shot && out.after.shot === out.before.shot) out.before.shot = null;
    // Same error-frame protections as the latest view: never slider on an implausible frame,
    // and when this day's shot failed/was scrubbed, offer the nearest good frame, dated.
    if (out.before && out.before.shot && !plausibleShot(before)) out.before.shot = null;
    if (out.after && !out.after.shot) {
      const lg = recent.find((s) => s.day <= day && plausibleShot(s)) || recent.find(plausibleShot);
      if (lg) out.lastGoodShot = { day: lg.day, shot: lg.data.shot };
    }
    return out;
  }

  // Latest view — make sure today's capture is fresh, then diff the two most recent.
  let recent = resolveShotRefs(await recentSnapshots(host, 'website', 10));
  const top = recent[0];
  const ageH = top && top.data && top.data.capturedAt ? (Date.now() - Date.parse(top.data.capturedAt)) / 3600000 : Infinity;
  // SELF-HEAL: today's capture stored WITHOUT a screenshot (the services were rate-limited and
  // the error image was rightly discarded) → retry on view, throttled to once per ~45 min per
  // host, so the panel heals itself the moment the screenshot service recovers instead of
  // showing "unavailable" until tomorrow.
  // shotStale = a pointer born from a FAILED shot on a CHANGE day (the frame shows the old
  // state next to the new banner text) — heal it exactly like a missing shot.
  const shotMissing = !!(top && top.data && ((!top.data.shot && !top.data.shotFrom) || top.data.shotStale)) && ageH * 60 > 45;
  if (force || ageH > 20 || shotMissing) {
    // SINGLE-FLIGHT per host: several viewers landing on a stale page at once (a shared link
    // doing the rounds) used to each trigger their own paid screenshot+banner capture (audit).
    // Everyone now awaits the one in-flight capture.
    const hk = cleanHost(host);
    if (!_capInFlight.has(hk)) {
      _capInFlight.set(hk, captureWebsiteFull(host, url).finally(() => _capInFlight.delete(hk)));
    }
    await _capInFlight.get(hk).catch(() => { /* capture failure → serve what we have */ });
    recent = resolveShotRefs(await recentSnapshots(host, 'website', 10));
  }
  const out = mk(recent[0] || null, recent[1] || null);
  // Visually-unchanged day: after's image is literally before's frame — a slider of two
  // identical images reads as a bug, so show the single view (frontend labels it honestly).
  if (out.after && out.before && out.after.shot && out.after.shot === out.before.shot) out.before.shot = null;
  // Old ERROR frames can sit in history (stored before the discard guard existed). Never let one
  // reach a viewer: if the slider's "before" frame is implausible, drop just its image (diffs
  // keep using its summary), and offer the most recent PLAUSIBLE frame as the display fallback
  // for when today has no shot.
  if (out.before && out.before.shot && !plausibleShot(recent[1])) out.before.shot = null;
  if (out.after && !out.after.shot) {
    // Look further back than the 5-day compare window — after a bad stretch (service refused a
    // site for days) the last good frame can be a week old; an honest dated image still beats
    // an empty box.
    const wide = await recentSnapshots(host, 'website', 15);
    const lg = wide.slice(1).find(plausibleShot);
    if (lg) out.lastGoodShot = { day: lg.day, shot: lg.data.shot };
  }
  return out;
}
const _capInFlight = new Map();   // host -> in-flight capture promise (single-flight guard)
