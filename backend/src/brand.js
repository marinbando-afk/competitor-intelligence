// "Your brand" knowledge base — EACH ACCOUNT stores their own brand; we scan its
// storefront to build a concise profile, then use that profile to tailor every
// competitor insight into a realistic "here's how you'd apply this to your brand".
//
//   GET  /api/my-brand                      -> { brand } | { brand: null }   (per logged-in account)
//   POST /api/my-brand { name, website }    -> { brand }   (scans site, builds profile)
//
// Stored via the snapshots table, one row per account: host `mybrand:<uid>`, channel
// 'profile'. `uid` is null for the DEFAULT/illustrative bucket (`mybrand:__default__`)
// used to tailor the shared EXAMPLE brands' "apply" tips during the daily warm, where
// there is no single logged-in viewer to personalize for.

import { siteSummary } from './website.js';
import { saveSnapshot, latestSnapshot } from './snapshots.js';
import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.BRAND_MODEL || 'claude-haiku-4-5';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const LEGACY_KEY = '__mybrand__';   // pre-multi-tenant singleton — migrated once into the default bucket
function brandKey(uid) { return uid ? ('mybrand:' + uid) : 'mybrand:__default__'; }

let _client;
function client() { if (!_client) _client = new Anthropic(); return _client; }
const oneLine = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
function cleanHost(h) { return String(h || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '').toLowerCase(); }
function stripText(h) {
  return String(h || '')
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ').trim();
}

const _cache = new Map();   // uid (or 'default') -> profile|null, undefined = not loaded
let _migrated = false;
// One-time, lazy: carry the old single-tenant brand into the default/illustrative
// bucket, so the shared EXAMPLE brands keep a sensible "apply" tip after this
// upgrade, with no manual migration step.
async function migrateLegacyOnce() {
  if (_migrated) return;
  _migrated = true;
  try {
    const already = await latestSnapshot(brandKey(null), 'profile');
    if (already) return;
    const legacy = await latestSnapshot(LEGACY_KEY, 'profile');
    if (legacy && legacy.profile) await saveSnapshot(brandKey(null), 'profile', legacy);
  } catch (e) { /* best effort */ }
}

export async function getMyBrand(uid) {
  await migrateLegacyOnce();
  const ck = uid || 'default';
  if (_cache.has(ck)) return _cache.get(ck);
  const d = await latestSnapshot(brandKey(uid), 'profile');
  const val = (d && d.profile) ? d : null;   // a 'cleared' marker has no profile
  _cache.set(ck, val);
  return val;
}

export async function clearMyBrand(uid) {
  await saveSnapshot(brandKey(uid), 'profile', { cleared: true, builtAt: new Date().toISOString() });
  _cache.set(uid || 'default', null);
}

export async function setMyBrand(uid, name, website, mainProduct) {
  const host = cleanHost(website);
  if (!host || host.indexOf('.') < 0) { const e = new Error('Enter a valid website (e.g. mybrand.com).'); e.status = 400; throw e; }
  const url = /^https?:\/\//i.test(website) ? website : ('https://' + host);
  const mp = oneLine(mainProduct).slice(0, 200);
  const { profile, catalog } = await buildProfile(host, url, name, mp);
  const data = { name: oneLine(name) || host, host, url, mainProduct: mp, profile, catalog, builtAt: new Date().toISOString() };
  await saveSnapshot(brandKey(uid), 'profile', data);
  _cache.set(uid || 'default', data);
  return data;
}

function money(n) { return n == null ? '?' : String(Math.round(n * 100) / 100); }
// A compact, factual catalogue (products with prices + any bundles/kits) so growth
// suggestions can reference the brand's REAL products, price points and bundles.
function buildCatalog(sum) {
  if (!sum) return '';
  const items = sum.items ? Object.values(sum.items) : [];
  if (!items.length) return `${sum.products || 0} products, prices ${money(sum.min)}–${money(sum.max)} (store currency)`;
  const isBundle = (t) => /\b(bundle|kit|set|duo|trio|pack|collection|routine|system)\b/i.test(t || '');
  const fmt = (i) => `${oneLine(i.title)} (${money(i.price)}${i.was && i.was > i.price ? ', was ' + money(i.was) : ''}${i.sale ? ', on sale' : ''})`;
  const bundles = items.filter((i) => isBundle(i.title)).slice(0, 6);
  const singles = items.filter((i) => !isBundle(i.title)).slice(0, 14);
  const parts = [`${sum.products} products, ${sum.onSale || 0} on sale, price range ${money(sum.min)}–${money(sum.max)} (store currency).`];
  if (singles.length) parts.push('Products: ' + singles.map(fmt).join('; ') + '.');
  if (bundles.length) parts.push('Bundles/kits: ' + bundles.map(fmt).join('; ') + '.');
  return parts.join(' ').slice(0, 1300);
}
async function buildProfile(host, url, name, mainProduct) {
  const sum = await siteSummary(host).catch(() => null);
  let homeText = '';
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
    if (r.ok) homeText = stripText(await r.text()).slice(0, 3500);
  } catch (e) { /* best effort */ }
  const catalog = buildCatalog(sum);
  const fallback = oneLine(`${name || host} (${host}). ${mainProduct ? 'Main product: ' + mainProduct + '. ' : ''}${catalog}`).slice(0, 1000);
  if (!process.env.ANTHROPIC_API_KEY || (!homeText && !catalog && !mainProduct)) return { profile: fallback, catalog };
  const system =
    'You are a brand strategist. From the homepage text and the catalogue, write a tight profile of THIS brand (<=120 words) covering: what they sell; who it is for; market positioning (premium / value / clinical / playful, etc); tone of voice; the PRICE RANGE plus a few hero products WITH their prices; any BUNDLES or kits and roughly how they are priced; and whether they tend to discount. ' +
    'If a MAIN PRODUCT is stated by the founder, centre the profile on it. ' +
    'Plain factual prose, no marketing fluff. This profile is used to tailor competitor-marketing suggestions to this brand, so be accurate and specific about products, prices and bundles.';
  const user = `BRAND: ${name || host} (${host})\n${mainProduct ? 'MAIN PRODUCT (stated by founder): ' + mainProduct + '\n' : ''}CATALOGUE: ${catalog}\n\nHOMEPAGE TEXT:\n${homeText}`;
  try {
    const resp = await client().messages.create({ model: MODEL, max_tokens: 400, system, messages: [{ role: 'user', content: user }] });
    const profile = oneLine((resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('')).slice(0, 1300) || fallback;
    return { profile, catalog };
  } catch (e) { return { profile: fallback, catalog }; }
}
