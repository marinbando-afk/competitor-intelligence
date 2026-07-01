// Website intelligence — captures a daily fingerprint of a competitor's storefront
// (a products.json summary + a screenshot) so we can show, day over day, exactly
// what changed: prices moved, a sale started, products added/removed — with a
// before/after screenshot slider in the app.
//
//   GET /api/website-compare?host=theoodie.com&url=https://www.theoodie.com
//     -> { after:{day,shot,summary}, before:{day,shot,summary}|null, changes:[...] }

import { saveSnapshot, recentSnapshots } from './snapshots.js';
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
async function siteBanner(homeText) {
  if (!process.env.ANTHROPIC_API_KEY || !homeText) return '';
  try {
    const system =
      'You are shown the top of a storefront homepage\'s visible text. If there is an ACTIVE promotion, sale, or offer being advertised (a banner, hero headline, or announcement bar — e.g. a percent-off sale, a free-gift offer, a discount code), state it in <=14 words, plain text. ' +
      'If the promotion has a NAMED OCCASION (e.g. "4th of July Sale", "Black Friday", "Anniversary Sale", "Back to School") — always keep that exact name in what you return; it is the most useful part (it tells us WHEN they run their biggest pushes), so never drop it in favour of just the discount percentage. ' +
      'If there is clearly no active promotion in the text, return an empty string. Only report what is actually stated — never guess or invent one.';
    const resp = await bannerClient().messages.create({ model: BANNER_MODEL, max_tokens: 60, system, messages: [{ role: 'user', content: homeText }] });
    return oneLine((resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('')).slice(0, 160);
  } catch (e) { return ''; }
}

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
  const target = 'https://api.screenshotone.com/take?access_key=' + encodeURIComponent(key) +
    '&url=' + encodeURIComponent(url) +
    '&format=jpg&image_quality=72&viewport_width=1280&viewport_height=800' +
    '&block_cookie_banners=true&block_banners_by_heuristics=true&block_ads=true&block_chats=true' +
    '&cache=true&cache_ttl=82800';
  try {
    const r = await fetch(target, { headers: { 'User-Agent': UA } });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 1200) return null; // too small to be a real screenshot
    return 'data:image/jpeg;base64,' + buf.toString('base64');
  } catch (e) { return null; }
}

// Capture today's fingerprint and persist it (one row per host/day; upserts).
export async function captureWebsite(host, url) {
  const u = url || ('https://' + cleanHost(host));
  const [summary, shot, homeText] = await Promise.all([siteSummary(host), siteShot(u), fetchHomeText(u)]);
  const banner = await siteBanner(homeText);   // the actual on-site promo headline, if any
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
  const aSale = a.onSale || 0, bSale = b.onSale || 0;
  if (aSale === 0 && bSale > 0) out.push('Sale started — ' + bSale + ' product' + (bSale > 1 ? 's' : '') + ' now discounted');
  else if (aSale > 0 && bSale === 0) out.push('Sale ended — nothing discounted now (was ' + aSale + ')');
  else if (bSale > aSale) out.push('Sale widened — ' + aSale + ' → ' + bSale + ' products discounted');
  else if (bSale < aSale) out.push('Sale narrowed — ' + aSale + ' → ' + bSale + ' products discounted');

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
export async function websiteCompare(host, url, day) {
  if (!host) { const e = new Error('Missing host.'); e.status = 400; throw e; }
  const shape = (s) => s ? { day: s.day, capturedAt: (s.data && s.data.capturedAt) || null, shot: (s.data && s.data.shot) || null, summary: (s.data && s.data.summary) || null } : null;
  const mk = (after, before, extra) => ({
    host: cleanHost(host),
    after: shape(after), before: shape(before),
    changes: (before && after) ? diffWebsite(before.data && before.data.summary, after.data && after.data.summary) : [],
    changedShots: (after && after.data && after.data.changedShots) || [],
    ...extra,
  });

  // Historical view — the capture on `day` vs the most recent earlier capture (no live re-capture).
  if (day) {
    const recent = await recentSnapshots(host, 'website', 40);   // sorted day DESC
    return mk(recent.find((s) => s.day === day) || null, recent.find((s) => s.day < day) || null, { day });
  }

  // Latest view — make sure today's capture is fresh, then diff the two most recent.
  let recent = await recentSnapshots(host, 'website', 5);
  const top = recent[0];
  const ageH = top && top.data && top.data.capturedAt ? (Date.now() - Date.parse(top.data.capturedAt)) / 3600000 : Infinity;
  if (ageH > 20) {
    await captureWebsiteFull(host, url);
    recent = await recentSnapshots(host, 'website', 5);
  }
  return mk(recent[0] || null, recent[1] || null);
}
