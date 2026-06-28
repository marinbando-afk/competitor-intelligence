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

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';
let _client;
function client() { if (!_client) _client = new Anthropic(); return _client; }

const oneLine = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const dayOf = (s) => String(s || '').split('T')[0].split(' ')[0];

// ── compact, diff-friendly text for each channel ──────────────────────────────
function fmtAds(d) {
  if (!d || !d.ads || !d.ads.length) return 'No active ads.';
  const out = [`${d.active || d.ads.length} active ad(s) on ${(d.platforms || []).join('/') || '?'}; newest ${d.newest || '?'}.`];
  d.ads.slice(0, 12).forEach((a) => {
    out.push(`- [${a.started || '?'}] ${a.hasVideo ? 'VIDEO' : 'IMAGE'} · page:"${a.page || '?'}"${a.cta ? ` · cta:"${a.cta}"` : ''}${a.landing ? ` · lands:${a.landing}` : ''} :: ${oneLine(a.text).slice(0, 170)}`);
  });
  return out.join('\n');
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
  ads: 'their Meta/Facebook ads. Surface, only if present in the data: what is NEW vs the previous capture; the HOOKS and ANGLES in the copy; creative FORMATS (video vs image/carousel); LANDING PAGES / domains / funnels (flag if they test multiple, switch domain, or send to a 3rd-party funnel); the advertising PAGE name (flag if it differs from the brand — they may be running ads from another page).',
  social: 'their organic social (Instagram / TikTok / Facebook). Surface, only if present: new posts vs the previous capture; recurring HOOKS / ANGLES / themes; FORMATS (Reel / Carousel / Post); which content is getting engagement; any product or campaign focus.',
  website: 'their online storefront. Surface what materially CHANGED vs the previous capture: sale scope, prices, products added/removed. If nothing material changed, say that plainly in one line.',
  email: 'their email marketing. Surface: sending CADENCE; OFFER / discount patterns; recurring THEMES and angles; what is newest. Give a real read, not a list of subjects.',
};

function parseOut(txt) {
  let o = null;
  try { o = JSON.parse(txt); } catch (e) {
    const m = txt.match(/\{[\s\S]*\}/);
    if (m) { try { o = JSON.parse(m[0]); } catch (_) { /* noop */ } }
  }
  if (!o || typeof o !== 'object') return { summary: oneLine(txt).slice(0, 240), bullets: [], apply: '' };
  return {
    summary: oneLine(o.summary).slice(0, 280),
    bullets: Array.isArray(o.bullets) ? o.bullets.map((b) => oneLine(b).slice(0, 220)).filter(Boolean).slice(0, 5) : [],
    apply: oneLine(o.apply).slice(0, 240),
  };
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
      `ADVISING BRAND — ${me.name}: ${me.profile}\n\n` +
      `Return ONLY minified JSON, no markdown: {"summary":"<=18 words","bullets":["<short specific point>", ...up to 4],"apply":"<the tailored suggestion>"}.`;
  } else {
    system += `Return ONLY minified JSON, no markdown: {"summary":"<one tight sentence (<=18 words): the single most important or most-new takeaway>","bullets":["<short, specific point>", ...]} with 0–4 bullets. If nothing changed and nothing notable, return a 1-sentence summary and an empty bullets array.`;
  }
  const user = `=== TODAY ===\n${todayBlock}\n\n=== PREVIOUS CAPTURE ===\n${prevBlock && prevBlock.trim() ? prevBlock : '(no earlier capture to compare against yet)'}`;
  const resp = await client().messages.create({ model: MODEL, max_tokens: 700, system, messages: [{ role: 'user', content: user }] });
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
export async function quickAngle(text, kind) {
  const t = oneLine(text).slice(0, 1400);
  if (!t || !process.env.ANTHROPIC_API_KEY) return { angle: '', apply: '' };
  const me = await getMyBrand();
  const key = (kind || 'ad') + '|' + ((me && me.host) || '') + '|' + t.slice(0, 220);
  if (_angleCache.has(key)) return _angleCache.get(key);
  const what = kind === 'post' ? 'organic social post' : 'ad';
  let system, wantJson = false;
  if (me && me.profile) {
    wantJson = true;
    system =
      `You are a performance-marketing strategist. For this competitor ${what}, return ONLY minified JSON: ` +
      `{"angle":"<the marketing angle / persuasion strategy in <=12 words; may combine two>","apply":"<one realistic, specific way the ADVISING BRAND below could use the SAME angle — reference their real products/positioning; if it doesn't fit them, say so briefly. Start with a verb, <=28 words>"}. No preamble, no markdown.\n` +
      `ADVISING BRAND — ${me.name}: ${me.profile}`;
  } else {
    system =
      `You are a performance-marketing strategist. Name the marketing ANGLE of this ${what} — the core persuasion strategy/hook, not a summary. ` +
      `You may combine up to two (e.g. "problem→solution: stress relief", "social proof + scarcity", "aspirational identity", "benefit-led comfort", "FOMO new drop", "sale-urgency / EOFY"). ` +
      `Answer in 12 words or fewer, ONLY the angle phrase — no quotes, no preamble, no trailing period.`;
  }
  try {
    const resp = await client().messages.create({ model: process.env.ANGLE_MODEL || MODEL, max_tokens: wantJson ? 150 : 40, system, messages: [{ role: 'user', content: t }] });
    const raw = oneLine((resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''));
    let out;
    if (wantJson) {
      let o = null;
      try { o = JSON.parse(raw); } catch (e) { const m = raw.match(/\{[\s\S]*\}/); if (m) { try { o = JSON.parse(m[0]); } catch (_) { /* noop */ } } }
      out = { angle: oneLine(o && o.angle).replace(/^["'\s]+|["'\s.]+$/g, '').slice(0, 100), apply: oneLine(o && o.apply).slice(0, 220) };
      if (!out.angle) out.angle = raw.replace(/[{}"]/g, '').slice(0, 100);
    } else {
      out = { angle: raw.replace(/^["'\s]+|["'\s.]+$/g, '').slice(0, 100), apply: '' };
    }
    _angleCache.set(key, out);
    return out;
  } catch (e) { return { angle: '', apply: '' }; }
}

// Read the latest cached insights; generate on demand if missing.
export async function getInsights(host, name) {
  let ins = await latestSnapshot(host, 'insights');
  const channels = ins ? Object.keys(ins).filter((k) => k !== 'generatedAt' && k !== '__day') : [];
  if (channels.length === 0 && process.env.ANTHROPIC_API_KEY) ins = await generateInsights(name || host, host);
  return ins || {};
}
