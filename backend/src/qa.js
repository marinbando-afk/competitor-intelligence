// qa.js — the SELF-AUDIT. Runs right after the daily briefs are delivered and answers one
// question: did today's brief miss or misreport anything the captures actually contain?
// Violations go to the founder's Slack, so the system catches its own misses before the
// founder does (founder, 12 Aug: "every day I catch something that you should've spotted
// — the whole point of this app is trust").
//
// Two layers, cheapest first:
//   1. DETERMINISTIC miss-checks — computed signals say a sale/new-product/fake-offer
//      exists; the delivered text must mention it. No model, no judgment, no excuses.
//   2. MODEL judge — one call over the delivered text + the computed facts, hunting
//      nonsense, contradictions and rule violations the mechanical gate can't see.
//      Judgment-layer only; its verdicts are advisory pings, never silent edits.

import Anthropic from '@anthropic-ai/sdk';
import { dailySignals } from './signals.js';
import { latestSnapshot } from './snapshots.js';
import { checkText } from './rulecheck.js';

const JUDGE_MODEL = process.env.QA_MODEL || 'claude-sonnet-4-6';
let _ai; function ai() { if (!_ai) _ai = new Anthropic(); return _ai; }

// The brand's block in the brief: from its *Name* header to the next header or end.
function blockFor(text, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = String(text || '').match(new RegExp('\\*' + esc + '\\*[\\s\\S]*?(?=\\n\\*|$)', 'i'));
  return m ? m[0] : '';
}

// Layer 1 — deterministic: every computed priority signal must surface in the text.
export function checkMisses(text, factsByBrand) {
  const out = [];
  for (const f of factsByBrand) {
    const block = blockFor(text, f.name);
    if (!block) { if (f.sale || f.products || f.staleOffers) out.push({ brand: f.name, rule: 'R-MISS-00', why: 'brand has priority signals but no block in the brief' }); continue; }
    if (f.sale && !/sale|%\s*off|\boff\b|discount/i.test(block)) out.push({ brand: f.name, rule: 'R-MISS-01', why: 'computed sale signal not mentioned: ' + String(f.sale).slice(0, 90) });
    if (f.products > 0 && !/new product|listed/i.test(block)) out.push({ brand: f.name, rule: 'R-MISS-02', why: f.products + ' new product(s) captured but not mentioned' });
    if (f.staleOffers > 0 && !/fake sale|out of season|stale|pretext/i.test(block)) out.push({ brand: f.name, rule: 'R-MISS-03', why: 'fake/stale offer flagged but not mentioned' });
    // R-MISS-04 (Pacific Foods, 12 Aug): posts are captured (the app shows the channel) but
    // the brief block has no Social row — an empty AI read silently dropped a channel.
    if (f.postsSeen > 0 && block.indexOf('📱 Social') < 0) out.push({ brand: f.name, rule: 'R-MISS-04', why: f.postsSeen + ' captured post(s) but no Social row in the brief' });
  }
  return out;
}

// Layer 1b — CONGRUENCE (founder, 12 Aug: "make an audit so the app and Slack, but also
// admin reads are all congruent"). Every surface derives from the same stored snapshots,
// so any disagreement is a pipeline bug — flagged, never rationalised. Compares the
// brand's brief block against the same stored app read the dashboard renders.
export function checkCongruence(block, appRead, f) {
  const out = [];
  if (!block || !appRead) return out;
  const rowFor = { ads: '📣 Ads', social: '📱 Social', website: '🛒 Website', email: '✉️ Email' };
  const shows = {
    ads: !!(appRead.ads && appRead.ads.summary),
    social: !!((appRead.social && appRead.social.summary) || (f.postsSeen || 0) > 0),
    website: !!((appRead.website && appRead.website.summary) || f.sale),
    email: !!(appRead.email && appRead.email.summary),
  };
  for (const ch of Object.keys(rowFor)) {
    const inBrief = block.indexOf(rowFor[ch]) >= 0;
    if (shows[ch] && !inBrief) out.push({ brand: f.name, rule: 'R-SYNC-01', why: 'app shows a ' + ch + ' read but the brief has no ' + ch + ' row' });
    if (!shows[ch] && inBrief) out.push({ brand: f.name, rule: 'R-SYNC-02', why: 'brief has a ' + ch + ' row but the app shows no ' + ch + ' read or capture' });
  }
  if (f.sale && appRead.website && appRead.website.summary && !/sale|%\s*off|discount|bogo|clearance/i.test(appRead.website.summary)) {
    out.push({ brand: f.name, rule: 'R-SYNC-03', why: 'sale signal fired but the app website read does not mention it' });
  }
  // R-SYNC-04 (Bare Bones, 13 Aug): Slack called a standing volume discount "New sale live"
  // while the app read said "running unchanged" — presence matched, the CLAIM contradicted.
  const appW = (appRead.website && appRead.website.summary) || '';
  if (/New sale live/i.test(block) && /unchanged|already running|still (running|live)/i.test(appW)) {
    out.push({ brand: f.name, rule: 'R-SYNC-04', why: 'brief calls the sale NEW while the app read says it is unchanged/already running' });
  }
  return out;
}

const JUDGE_RULES = `You are auditing a competitor-intelligence daily brief against the product's reporting rules. Core rules:
- A NEW sale, sale change, price move, new product or new funnel must be called out prominently, never buried or labeled routine.
- Every claim must be grounded in the FACTS provided; flag anything the facts do not support (hallucinated numbers, invented dates, wrong brands).
- No active-ad totals or capture volumes; launch counts are fine.
- Dates must read naturally (yesterday/today); ISO dates only for genuine launch dates.
- No truncated or dangling sentences, no encoding garbage, no unbalanced quotes.
- A line must never contradict another line about the same brand.
Report ONLY real violations — an empty list is the expected outcome. Be precise and quote the offending text.`;

async function judgeText(text, factsByBrand) {
  if (!process.env.ANTHROPIC_API_KEY) return [];
  try {
    const r = await ai().messages.create({
      model: JUDGE_MODEL, max_tokens: 800, temperature: 0,
      system: JUDGE_RULES,
      messages: [{ role: 'user', content: 'FACTS (computed from captures):\n' + JSON.stringify(factsByBrand) + '\n\nDELIVERED BRIEF:\n' + String(text || '').slice(0, 9000) + '\n\nReturn a JSON array of violations: [{"brand":"","rule":"judge","why":"","quote":""}]. Return [] if clean.' }],
    });
    const raw = (r.content && r.content[0] && r.content[0].text) || '[]';
    const m = raw.match(/\[[\s\S]*\]/);
    const arr = m ? JSON.parse(m[0]) : [];
    return Array.isArray(arr) ? arr.filter((v) => v && v.why).slice(0, 10) : [];
  } catch (e) { console.warn('qa judge:', e.message); return []; }
}

// Entry point — fire-and-forget after a real delivery. postText is injected so this
// module never imports slack.js (avoids a cycle).
export async function auditDaily({ text, brands, postText }) {
  try {
    const factsByBrand = [];
    const appReads = new Map();
    for (const b of brands || []) {
      try {
        const s = await dailySignals(b.host, false);
        const n = (x) => (Array.isArray(x) ? x.length : 0);
        factsByBrand.push({ name: b.name, host: b.host, sale: s.sale || '', products: n(s.products), staleOffers: n(s.staleOffer), funnels: n(s.funnel), newAds: n(s.activity && s.activity.ads), newEmails: n(s.activity && s.activity.emails), postsSeen: s.postsSeen || 0 });
        // The same stored read the app renders — congruence is only judged against a FRESH
        // read (a stale one means the brief used deterministic lines, a different, honest path).
        try {
          const ins = await latestSnapshot(b.host, 'insights');
          if (ins && ins.__day && (Date.now() - Date.parse(ins.__day)) <= 2 * 864e5) appReads.set(b.name, ins);
        } catch (e) { /* congruence skipped for this brand */ }
      } catch (e) { /* brand facts are best-effort */ }
    }
    const misses = checkMisses(text, factsByBrand);
    for (const f of factsByBrand) {
      const ar = appReads.get(f.name);
      if (ar) misses.push(...checkCongruence(blockFor(text, f.name), ar, f));
    }
    const hard = checkText(text, { surface: 'slack' }).map((v) => ({ brand: '(brief)', rule: v.id, why: v.why }));
    const judged = await judgeText(text, factsByBrand);
    const all = misses.concat(hard, judged);
    if (all.length && typeof postText === 'function') {
      const msg = '🧯 *QA audit — ' + all.length + ' issue' + (all.length > 1 ? 's' : '') + ' in today\'s delivered brief:*\n'
        + all.slice(0, 10).map((v) => '• ' + (v.brand || '') + ' — ' + (v.rule || 'judge') + ': ' + String(v.why).slice(0, 160) + (v.quote ? ' — “' + String(v.quote).slice(0, 80) + '”' : '')).join('\n');
      await postText(msg);
    }
    console.log('✓ qa audit: ' + all.length + ' issue(s) (' + misses.length + ' misses, ' + hard.length + ' hard, ' + judged.length + ' judged)');
    return all;
  } catch (e) { console.warn('qa audit:', e.message); return []; }
}
