// "Your brand" knowledge base — the founder stores their OWN brand once; we scan
// its storefront to build a concise profile, then use that profile to tailor every
// competitor insight into a realistic "here's how you'd apply this to your brand".
//
//   GET  /api/my-brand                      -> { brand } | { brand: null }
//   POST /api/my-brand { name, website }    -> { brand }   (scans site, builds profile)
//
// Stored as a singleton via the snapshots table (host '__mybrand__', channel 'profile').

import { siteSummary } from './website.js';
import { saveSnapshot, latestSnapshot } from './snapshots.js';
import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.BRAND_MODEL || 'claude-haiku-4-5';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const KEY = '__mybrand__';

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

let _cache; // undefined = not loaded, null = none set
export async function getMyBrand() {
  if (_cache !== undefined) return _cache;
  const d = await latestSnapshot(KEY, 'profile');
  _cache = (d && d.profile) ? d : null;   // a 'cleared' marker has no profile
  return _cache;
}

export async function clearMyBrand() {
  await saveSnapshot(KEY, 'profile', { cleared: true, builtAt: new Date().toISOString() });
  _cache = null;
}

export async function setMyBrand(name, website, mainProduct) {
  const host = cleanHost(website);
  if (!host || host.indexOf('.') < 0) { const e = new Error('Enter a valid website (e.g. mybrand.com).'); e.status = 400; throw e; }
  const url = /^https?:\/\//i.test(website) ? website : ('https://' + host);
  const mp = oneLine(mainProduct).slice(0, 200);
  const profile = await buildProfile(host, url, name, mp);
  const data = { name: oneLine(name) || host, host, url, mainProduct: mp, profile, builtAt: new Date().toISOString() };
  await saveSnapshot(KEY, 'profile', data);
  _cache = data;
  return data;
}

async function buildProfile(host, url, name, mainProduct) {
  const sum = await siteSummary(host).catch(() => null);
  let homeText = '';
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
    if (r.ok) homeText = stripText(await r.text()).slice(0, 3500);
  } catch (e) { /* best effort */ }
  const titles = sum && sum.items ? Object.values(sum.items).map((i) => i.title).filter(Boolean).slice(0, 40).join('; ') : '';
  const priceLine = sum ? `~${sum.products} products, prices ${sum.min}–${sum.max}` : '';
  const fallback = oneLine(`${name || host} (${host}). ${mainProduct ? 'Main product: ' + mainProduct + '. ' : ''}${priceLine}. Sells: ${titles}`).slice(0, 800);
  if (!process.env.ANTHROPIC_API_KEY || (!homeText && !titles && !mainProduct)) return fallback;
  const system =
    'You are a brand strategist. From the homepage text and product list, write a tight profile of THIS brand (<=95 words) covering: what they sell, who it is for, market positioning (premium / value / clinical / playful, etc), tone of voice, price range, and 3–5 key product categories. ' +
    'If a MAIN PRODUCT is stated by the founder, centre the profile on it. ' +
    'Plain factual prose, no marketing fluff or hype. This profile will be used to tailor competitor-marketing suggestions to this brand, so be accurate and specific.';
  const user = `BRAND: ${name || host} (${host})\n${mainProduct ? 'MAIN PRODUCT (stated by founder): ' + mainProduct + '\n' : ''}PRICING: ${priceLine}\nPRODUCT TITLES: ${titles}\n\nHOMEPAGE TEXT:\n${homeText}`;
  try {
    const resp = await client().messages.create({ model: MODEL, max_tokens: 320, system, messages: [{ role: 'user', content: user }] });
    return oneLine((resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('')).slice(0, 1100) || fallback;
  } catch (e) { return fallback; }
}
