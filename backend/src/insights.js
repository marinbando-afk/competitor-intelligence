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
import { recentSnapshots, saveSnapshot, latestSnapshot } from './snapshots.js';
import { getEmails } from './email.js';
import { diffWebsite, siteShot } from './website.js';
import { getMyBrand } from './brand.js';
import { transcribeVideo } from './transcribe.js';

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

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';            // vision/angle analysis (quality-critical) + the credit ping
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
  const thirdPages = pages.filter(([p]) => p !== '?' && !own(p));
  const thirdDoms = doms.filter(([dm]) => !own(dm));
  const ownDoms = doms.filter(([dm]) => own(dm));
  const text = [
    `FUNNEL FACTS (computed across all ${ads.length} ads — ground truth, do NOT contradict):`,
    `  Ad pages: ${pages.slice(0, 8).map(([p, n]) => `"${p}"×${n}`).join(', ')}.`,
    thirdPages.length ? `  >> THIRD-PARTY pages (not the brand's own): ${thirdPages.map(([p, n]) => `"${p}"×${n}`).join(', ')} — publisher/advertorial or media-partner placements, worth surfacing.` : `  All ads run from the brand's own page(s).`,
    `  Landing domains: ${doms.slice(0, 10).map(([dm, n]) => `${dm}×${n}`).join(', ')}.`,
    thirdDoms.length ? `  >> THIRD-PARTY landing domains (off the brand's own sites): ${thirdDoms.map(([dm, n]) => `${dm}×${n}`).join(', ')} — they're sending traffic off-domain.` : `  All landings on the brand's own domain(s)${ownDoms.length > 1 ? ` (multiple regional sites: ${ownDoms.map(([dm]) => dm).join(', ')})` : ''}.`,
  ].join('\n');
  const isThird = (a) => (oneLine(a.page) && !own(a.page)) || (adHost(a.landing) && !own(adHost(a.landing)));
  return { text, own, isThird };
}
function fmtAds(d) {
  if (!d || !d.ads || !d.ads.length) return 'No active ads.';
  const ads = d.ads;
  const ff = funnelFacts(ads, d.brand);
  // Sample ads — include every third-party ad, then fill with first-party, so both are visible.
  const third = ads.filter(ff.isThird), first = ads.filter((a) => !ff.isThird(a));
  const sample = third.slice(0, 6).concat(first.slice(0, Math.max(6, 16 - Math.min(third.length, 6))));
  const lines = sample.map((a) => `- [${a.started || '?'}] ${a.hasVideo ? 'VIDEO' : 'IMAGE'} · page:"${a.page || '?'}"${ff.own(a.page) ? '' : ' (3RD-PARTY)'}${a.cta ? ` · cta:"${a.cta}"` : ''}${a.landing ? ` · lands:${adHost(a.landing)}${ff.own(adHost(a.landing)) ? '' : ' (3RD-PARTY)'}` : ''} :: ${oneLine(a.text).slice(0, 170)}`);
  return [`${d.active || ads.length} active ad(s) on ${(d.platforms || []).join('/') || '?'}; newest ${d.newest || '?'}.`, ff.text, 'SAMPLE ADS:'].concat(lines).join('\n');
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
function fmtWeb(d) {
  if (!d || !d.summary) return 'No storefront data.';
  const s = d.summary;
  // Sale status leads every time, independent of whether anything changed since the
  // last capture — an ONGOING sale must never go unmentioned just because it isn't new.
  const saleLine = s.onSale
    ? `ACTIVE SALE — ${s.onSale} of ${s.products ?? '?'} products discounted (price range ${s.min ?? '?'}–${s.max ?? '?'}).`
    : `No sale — ${s.products ?? '?'} products, price range ${s.min ?? '?'}–${s.max ?? '?'}, none discounted.`;
  const bannerLine = d.banner ? ` Promo headline seen on-site: "${d.banner}".` : '';
  return saleLine + bannerLine;
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

async function classifyUrls(items) {   // items: [{ host, url }]
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
      out.set(f.host, val); _landCache.set(f.host, { at: Date.now(), val });
    });
  }
  for (const f of thin.slice(0, 3)) {   // cap browser renders per run (vision cost)
    const val = await visionClassifyLanding(f.host, f.url, f.adText);
    out.set(f.host, val); _landCache.set(f.host, { at: Date.now(), val });
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
  ads: 'their Meta/Facebook ads. Use the FUNNEL FACTS block as ground truth for pages and landing domains — NEVER claim there are no third-party pages or off-domain landings unless the facts confirm it; if any THIRD-PARTY page or domain is listed (e.g. a news-publisher advertorial / native ad, an affiliate or media-partner funnel), SURFACE it as a notable tactic. LANDING-PAGE FORMAT: when a LANDING PAGE FORMATS block is provided, state each landing page\'s ACTUAL format from it (listicle, advertorial, third-party review, sales page, product page, quiz funnel, etc.) — those were produced by fetching and reading the real page. NEVER infer a landing page\'s format, purpose, or that it is a "staging"/"test"/"pre-launch"/"variant" page from its URL or subdomain name (e.g. do not assume "pre." means pre-launch); if a page is marked not-analyzable, say it wasn\'t read rather than guessing. Also surface, only if present: what is NEW vs the previous capture; the HOOKS and ANGLES in the copy; creative FORMATS (video vs image/carousel); whether they test multiple regional own-domains. Do not over-generalize beyond what the facts and sample support.',
  social: 'their organic social (Instagram / TikTok / Facebook). Engagement counts (views, likes, comments) are CUMULATIVE lifetime totals: they only ever climb, they grow with how long a post has been live, and a post does most of its growth in the first day or two. So a newer post almost always shows fewer than an older one, and that is normal — NOT a decline. NEVER frame a lower count — on a newer post, or versus a previous capture — as a drop, collapse, slump, dip, decay, or "reach/algorithm" problem, and never compute view/like deltas between captures (different posts are not comparable that way). What matters is STACKED engagement. Surface, only if present: which posts have accumulated the most total engagement; what is genuinely NEW since the previous capture (new posts / series); recurring HOOKS / ANGLES / themes; FORMATS (Reel / Carousel / Post); and any product or campaign focus.',
  website: 'their online storefront. ALWAYS lead with whether a sale/promotion is ACTIVE right now (per the ACTIVE SALE / Promo headline facts) — this is independent of whether it changed since the previous capture; an ONGOING, unchanged sale must still be named explicitly, never omitted just because it isn\'t new. If the "Promo headline" fact names a specific OCCASION (a holiday or named sale event — e.g. "4th of July Sale", "Black Friday", "Anniversary Sale"), you MUST use that exact occasion name in the summary/bullets (e.g. "still running their 4th of July sale, 60% off") — the occasion is valuable timing intel (when they run their biggest pushes), so never flatten it down to a generic "an active sale" or just the discount percentage. Then surface what materially CHANGED vs the previous capture: sale scope, prices, products added/removed. If nothing changed AND there is no active sale, say that plainly in one line.',
  email: 'their email marketing. Surface: sending CADENCE; OFFER / discount patterns; recurring THEMES and angles; what is newest. Give a real read, not a list of subjects.',
};

// Trim to a word boundary with an ellipsis — never cut mid-word / mid-sentence.
function clip(s, n) {
  s = oneLine(s);
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
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
      summary: clip(o.summary, 240),
      bullets: Array.isArray(o.bullets) ? o.bullets.map((b) => clip(b, 230)).filter(Boolean).slice(0, 5) : [],
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

async function ask(channel, brand, todayBlock, prevBlock, me) {
  if (!todayBlock || !todayBlock.trim()) return null;
  let system =
    `You are WatchBack, a sharp eCommerce competitor-intelligence analyst. Analyze ${brand}'s ${channel} — ${GUIDE[channel]}\n\n` +
    `Use ONLY the DATA the user provides. Be specific: cite dates, numbers, offers, domains, handles, formats. ` +
    `Compare TODAY against the PREVIOUS capture and lead with what is NEW or CHANGED — do not just restate static facts or repeat an unchanging description. ` +
    `If something isn't supported by the data, leave it out — never invent. Write for a busy marketer. Keep every bullet and the apply SHORT and COMPLETE — a finished thought that never trails off mid-sentence; if a point won't fit concisely, drop detail rather than cut the ending.\n\n`;
  if (me && me.profile) {
    system +=
      `Also add an "apply" field. Act as ${me.name}'s DIRECTOR OF GROWTH: turn this channel's single most important takeaway into ONE realistic, specific move THEY could actually make — grounded in their ACTUAL products, prices and bundles below, and naming a real product, price point or bundle of theirs where you can. It should be doable without heavy resources; if it genuinely needs real effort or spend (new creative, a UGC budget, building a bundle, a price test, an email flow), name that cost briefly so it's clear you know what it takes. Be honest — if the tactic doesn't fit their catalogue or positioning, say so in one line instead of forcing it. Start with a verb, ≤ 34 words, finish the sentence.\n` +
      `ADVISING BRAND — ${me.name}${me.mainProduct ? ' (main product: ' + me.mainProduct + ')' : ''}: ${me.profile}${me.catalog ? '\nTHEIR CATALOGUE (real products, prices, bundles): ' + me.catalog : ''}\n\n` +
      `Return ONLY minified JSON, no markdown: {"summary":"<=18 words","bullets":["<one complete, self-contained point, ≤ 20 words — never trail off>", ...up to 4],"apply":"<the tailored growth move, a finished sentence>"}.`;
  } else {
    system += `Return ONLY minified JSON, no markdown: {"summary":"<one tight sentence (<=18 words): the single most important or most-new takeaway>","bullets":["<one complete, self-contained point, ≤ 20 words — never trail off mid-thought>", ...]} with 0–4 bullets. If nothing changed and nothing notable, return a 1-sentence summary and an empty bullets array.`;
  }
  const user = `=== TODAY ===\n${todayBlock}\n\n=== PREVIOUS CAPTURE ===\n${prevBlock && prevBlock.trim() ? prevBlock : '(no earlier capture to compare against yet)'}`;
  const resp = await client().messages.create({ model: INSIGHTS_MODEL, max_tokens: 1200, system, messages: [{ role: 'user', content: user }] });
  const txt = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return parseOut(txt);
}

// Generate insights for all channels of one brand and cache them as a snapshot.
export async function generateInsights(brand, host, uid) {
  if (!process.env.ANTHROPIC_API_KEY || !host) return null;
  brand = brand || host;
  const out = {};
  const me = await getMyBrand(uid);   // uid unset (e.g. the daily warm) -> the shared/default illustrative brand

  try {
    const r = await recentSnapshots(host, 'ads', 2);
    if (r[0] && r[0].data) {
      const lf = await landingFormats(r[0].data.ads || []);   // FETCH + read each landing page, classify its format
      out.ads = await ask('ads', brand, fmtAds(r[0].data) + lf, r[1] && r[1].data ? fmtAds(r[1].data) : '', me);
    }
  } catch (e) { /* skip */ }

  try {
    const today = [], prev = [];
    for (const [pf, lab] of [['instagram', 'Instagram'], ['tiktok', 'TikTok'], ['facebook', 'Facebook']]) {
      const r = await recentSnapshots(host, pf, 2);
      if (r[0] && r[0].data && r[0].data.posts && r[0].data.posts.length) today.push(fmtPosts(r[0].data.posts, lab + ' @' + (r[0].data.handle || '')));
      if (r[1] && r[1].data && r[1].data.posts && r[1].data.posts.length) prev.push(fmtPosts(r[1].data.posts, lab, true));
    }
    if (today.length) out.social = await ask('social', brand, today.join('\n\n'), prev.join('\n\n'), me);
  } catch (e) { /* skip */ }

  try {
    const r = await recentSnapshots(host, 'website', 2);
    if (r[0] && r[0].data) {
      const changes = (r[1] && r[1].data) ? diffWebsite(r[1].data.summary, r[0].data.summary) : null;
      const todayBlock = fmtWeb(r[0].data) + '\nCHANGES vs previous capture: ' + (changes ? (changes.join('; ') || 'none detected') : 'n/a (first capture)');
      out.website = await ask('website', brand, todayBlock, r[1] && r[1].data ? fmtWeb(r[1].data) : '', me);
    }
  } catch (e) { /* skip */ }

  try {
    const em = await getEmails(host);
    const all = (em && em.emails) || [];
    const real = all.filter((e) => !isConfirmEmail(e));   // ignore opt-in confirmations
    if (all.length && !real.length) {
      // Only a sign-up confirmation so far — nothing to analyse. Don't invent cadence/offers/suggestions.
      out.email = { summary: 'Only the sign-up confirmation captured so far — their first newsletter can take up to 24 hours to arrive.', bullets: [] };
    } else if (real.length) {
      out.email = await ask('email', brand, fmtEmail({ emails: real, summary: em.summary }), '', me);
    }
  } catch (e) { /* skip */ }

  // Drop empty channels.
  Object.keys(out).forEach((k) => { if (!out[k]) delete out[k]; });
  if (Object.keys(out).length) { out.generatedAt = new Date().toISOString(); await saveSnapshot(host, 'insights', out); }
  return out;
}

// A one-line marketing ANGLE for a single ad/post, generated on demand (cheap,
// cached) when the user opens its preview.
const _angleCache = new Map();
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
  const key = (kind || 'ad') + '|' + ((me && me.host) || '') + '|' + (img ? 'V' : 'T') + (script ? 'S' : '') + '|' + String(image || '').slice(0, 70) + '|' + String(video || '').slice(0, 50) + '|' + t.slice(0, 100);
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
    const resp = await client().messages.create({ model: process.env.ANGLE_MODEL || MODEL, max_tokens: 400, system, messages: [{ role: 'user', content }] });
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
    _angleCache.set(key, out);
    return out;
  } catch (e) {
    console.warn('quickAngle vision failed (' + e.message + ') — retrying copy-only');
    if (img) { try { const out = await run(false); _angleCache.set(key, out); return out; } catch (e2) { /* fall through */ } }
    return { angle: '', hook: '', creative: '', apply: '' };
  }
}

// Read the latest cached insights; generate on demand if missing.
export async function getInsights(host, name, refresh, uid) {
  let ins = refresh ? null : await latestSnapshot(host, 'insights');
  const channels = ins ? Object.keys(ins).filter((k) => k !== 'generatedAt' && k !== '__day') : [];
  if (channels.length === 0 && process.env.ANTHROPIC_API_KEY) ins = await generateInsights(name || host, host, uid);
  return ins || {};
}
