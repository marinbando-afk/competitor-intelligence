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
import { diffWebsite } from './website.js';
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

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';
let _client;
function client() { if (!_client) _client = new Anthropic(); return _client; }

const oneLine = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const dayOf = (s) => String(s || '').split('T')[0].split(' ')[0];

// ── compact, diff-friendly text for each channel ──────────────────────────────
function adHost(u) { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { return ''; } }
const INS_STOP = new Set(['the', 'and', 'for', 'shop', 'store', 'official', 'ltd', 'inc', 'llc', 'brand', 'online', 'cosmetics', 'beauty', 'skin', 'care', 'fashion', 'clothing', 'apparel', 'group', 'collective', 'australia']);
function brandToks(name) { return [...new Set(String(name || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !INS_STOP.has(w)))]; }
function fmtAds(d) {
  if (!d || !d.ads || !d.ads.length) return 'No active ads.';
  const ads = d.ads;
  // ── Funnel facts computed across ALL ads, so the model can't infer the wrong thing
  //    from a small sample (e.g. wrongly claim "no 3rd-party" when a publisher advertorial exists). ──
  const pageN = {}, domN = {};
  ads.forEach((a) => { const p = oneLine(a.page) || '?'; pageN[p] = (pageN[p] || 0) + 1; const dm = adHost(a.landing); if (dm) domN[dm] = (domN[dm] || 0) + 1; });
  const pages = Object.entries(pageN).sort((x, y) => y[1] - x[1]);
  const doms = Object.entries(domN).sort((x, y) => y[1] - x[1]);
  let toks = brandToks(d.brand);
  if (!toks.length && doms.length) { const sld = doms[0][0].split('.')[0]; if (sld.length >= 3) toks = [sld]; } // fallback: the dominant domain's root
  const own = (s) => { s = String(s || '').toLowerCase(); return !toks.length || toks.some((t) => s.indexOf(t) >= 0); };
  const thirdPages = pages.filter(([p]) => p !== '?' && !own(p));
  const thirdDoms = doms.filter(([dm]) => !own(dm));
  const ownDoms = doms.filter(([dm]) => own(dm));
  const funnel = [
    `FUNNEL FACTS (computed across all ${ads.length} ads — ground truth, do NOT contradict):`,
    `  Ad pages: ${pages.slice(0, 8).map(([p, n]) => `"${p}"×${n}`).join(', ')}.`,
    thirdPages.length ? `  >> THIRD-PARTY pages (not the brand's own): ${thirdPages.map(([p, n]) => `"${p}"×${n}`).join(', ')} — publisher/advertorial or media-partner placements, worth surfacing.` : `  All ads run from the brand's own page(s).`,
    `  Landing domains: ${doms.slice(0, 10).map(([dm, n]) => `${dm}×${n}`).join(', ')}.`,
    thirdDoms.length ? `  >> THIRD-PARTY landing domains (off the brand's own sites): ${thirdDoms.map(([dm, n]) => `${dm}×${n}`).join(', ')} — they're sending traffic off-domain.` : `  All landings on the brand's own domain(s)${ownDoms.length > 1 ? ` (multiple regional sites: ${ownDoms.map(([dm]) => dm).join(', ')})` : ''}.`,
  ].join('\n');
  // Sample ads — include every third-party ad, then fill with first-party, so both are visible.
  const isThird = (a) => (oneLine(a.page) && !own(a.page)) || (adHost(a.landing) && !own(adHost(a.landing)));
  const third = ads.filter(isThird), first = ads.filter((a) => !isThird(a));
  const sample = third.slice(0, 6).concat(first.slice(0, Math.max(6, 16 - Math.min(third.length, 6))));
  const lines = sample.map((a) => `- [${a.started || '?'}] ${a.hasVideo ? 'VIDEO' : 'IMAGE'} · page:"${a.page || '?'}"${own(a.page) ? '' : ' (3RD-PARTY)'}${a.cta ? ` · cta:"${a.cta}"` : ''}${a.landing ? ` · lands:${adHost(a.landing)}${own(adHost(a.landing)) ? '' : ' (3RD-PARTY)'}` : ''} :: ${oneLine(a.text).slice(0, 170)}`);
  return [`${d.active || ads.length} active ad(s) on ${(d.platforms || []).join('/') || '?'}; newest ${d.newest || '?'}.`, funnel, 'SAMPLE ADS:'].concat(lines).join('\n');
}
function fmtPosts(posts, label) {
  if (!posts || !posts.length) return '';
  const out = [`${label}: ${posts.length} post(s).`];
  posts.slice(0, 8).forEach((p) => {
    const eng = p.views != null ? `${p.views} views` : (p.likes != null ? `${p.likes} likes` : '');
    out.push(`- [${dayOf(p.date)}] ${p.kind || 'Post'}${eng ? ` · ${eng}` : ''}${p.comments != null ? `, ${p.comments} comments` : ''} :: ${oneLine(p.text).slice(0, 150)}`);
  });
  return out.join('\n');
}
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
  return `${s.products ?? '?'} products; ${s.onSale || 0} on sale; price range ${s.min ?? '?'}–${s.max ?? '?'}.`;
}

// ── per-channel analyst guidance ──────────────────────────────────────────────
const GUIDE = {
  ads: 'their Meta/Facebook ads. Use the FUNNEL FACTS block as ground truth for pages and landing domains — NEVER claim there are no third-party pages or off-domain landings unless the facts confirm it; if any THIRD-PARTY page or domain is listed (e.g. a news-publisher advertorial / native ad, an affiliate or media-partner funnel), SURFACE it as a notable tactic. Also surface, only if present: what is NEW vs the previous capture; the HOOKS and ANGLES in the copy; creative FORMATS (video vs image/carousel); whether they test multiple regional own-domains. Do not over-generalize beyond what the facts and sample support.',
  social: 'their organic social (Instagram / TikTok / Facebook). Surface, only if present: new posts vs the previous capture; recurring HOOKS / ANGLES / themes; FORMATS (Reel / Carousel / Post); which content is getting engagement; any product or campaign focus.',
  website: 'their online storefront. Surface what materially CHANGED vs the previous capture: sale scope, prices, products added/removed. If nothing material changed, say that plainly in one line.',
  email: 'their email marketing. Surface: sending CADENCE; OFFER / discount patterns; recurring THEMES and angles; what is newest. Give a real read, not a list of subjects.',
};

function parseOut(txt) {
  const raw = String(txt || '');
  let o = null;
  try { o = JSON.parse(raw); } catch (e) {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) { try { o = JSON.parse(m[0]); } catch (_) { /* noop */ } }
  }
  if (o && typeof o === 'object') {
    return {
      summary: oneLine(o.summary).slice(0, 280),
      bullets: Array.isArray(o.bullets) ? o.bullets.map((b) => oneLine(b).slice(0, 220)).filter(Boolean).slice(0, 5) : [],
      apply: oneLine(o.apply).slice(0, 240),
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
    if (summary || bullets.length) return { summary: summary.slice(0, 280), bullets, apply: grab('apply').slice(0, 240) };
  }
  // Genuinely plain text — use it as the summary.
  return { summary: oneLine(raw).slice(0, 240), bullets: [], apply: '' };
}

async function ask(channel, brand, todayBlock, prevBlock, me) {
  if (!todayBlock || !todayBlock.trim()) return null;
  let system =
    `You are IntelAI, a sharp eCommerce competitor-intelligence analyst. Analyze ${brand}'s ${channel} — ${GUIDE[channel]}\n\n` +
    `Use ONLY the DATA the user provides. Be specific: cite dates, numbers, offers, domains, handles, formats. ` +
    `Compare TODAY against the PREVIOUS capture and lead with what is NEW or CHANGED — do not just restate static facts or repeat an unchanging description. ` +
    `If something isn't supported by the data, leave it out — never invent. Write for a busy marketer.\n\n`;
  if (me && me.profile) {
    system +=
      `Also add an "apply" field: ONE realistic, specific way the ADVISING BRAND below could apply this channel's single most important takeaway to their OWN marketing. Reference their ACTUAL products/positioning; be concrete and honest — if the tactic doesn't transfer well to them, say so briefly instead of forcing it. Start with a verb, <=30 words.\n` +
      `ADVISING BRAND — ${me.name}${me.mainProduct ? ' (main product: ' + me.mainProduct + ')' : ''}: ${me.profile}\n\n` +
      `Return ONLY minified JSON, no markdown: {"summary":"<=18 words","bullets":["<short specific point>", ...up to 4],"apply":"<the tailored suggestion>"}.`;
  } else {
    system += `Return ONLY minified JSON, no markdown: {"summary":"<one tight sentence (<=18 words): the single most important or most-new takeaway>","bullets":["<short, specific point>", ...]} with 0–4 bullets. If nothing changed and nothing notable, return a 1-sentence summary and an empty bullets array.`;
  }
  const user = `=== TODAY ===\n${todayBlock}\n\n=== PREVIOUS CAPTURE ===\n${prevBlock && prevBlock.trim() ? prevBlock : '(no earlier capture to compare against yet)'}`;
  const resp = await client().messages.create({ model: MODEL, max_tokens: 1000, system, messages: [{ role: 'user', content: user }] });
  const txt = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return parseOut(txt);
}

// Generate insights for all channels of one brand and cache them as a snapshot.
export async function generateInsights(brand, host) {
  if (!process.env.ANTHROPIC_API_KEY || !host) return null;
  brand = brand || host;
  const out = {};
  const me = await getMyBrand();

  try {
    const r = await recentSnapshots(host, 'ads', 2);
    if (r[0] && r[0].data) out.ads = await ask('ads', brand, fmtAds(r[0].data), r[1] && r[1].data ? fmtAds(r[1].data) : '', me);
  } catch (e) { /* skip */ }

  try {
    const today = [], prev = [];
    for (const [pf, lab] of [['instagram', 'Instagram'], ['tiktok', 'TikTok'], ['facebook', 'Facebook']]) {
      const r = await recentSnapshots(host, pf, 2);
      if (r[0] && r[0].data && r[0].data.posts && r[0].data.posts.length) today.push(fmtPosts(r[0].data.posts, lab + ' @' + (r[0].data.handle || '')));
      if (r[1] && r[1].data && r[1].data.posts && r[1].data.posts.length) prev.push(fmtPosts(r[1].data.posts, lab));
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
    if (em && em.emails && em.emails.length) out.email = await ask('email', brand, fmtEmail(em), '', me);
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
export async function quickAngle(text, kind, image, video) {
  const t = oneLine(text).slice(0, 1400);
  if (!process.env.ANTHROPIC_API_KEY) return { angle: '', hook: '', creative: '', apply: '' };
  const me = await getMyBrand();
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
    ? `,"apply":"<one realistic, specific way the ADVISING BRAND could use the SAME approach — reference their real products/positioning; if it doesn't fit, say so briefly. Start with a verb, <=28 words>"`
    : `,"apply":""`;
  const brandLine = (me && me.profile) ? `\nADVISING BRAND — ${me.name}${me.mainProduct ? ' (main product: ' + me.mainProduct + ')' : ''}: ${me.profile}` : '';
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
export async function getInsights(host, name, refresh) {
  let ins = refresh ? null : await latestSnapshot(host, 'insights');
  const channels = ins ? Object.keys(ins).filter((k) => k !== 'generatedAt' && k !== '__day') : [];
  if (channels.length === 0 && process.env.ANTHROPIC_API_KEY) ins = await generateInsights(name || host, host);
  return ins || {};
}
