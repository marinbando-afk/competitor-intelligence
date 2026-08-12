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
    for (const b of brands || []) {
      try {
        const s = await dailySignals(b.host, false);
        const n = (x) => (Array.isArray(x) ? x.length : 0);
        factsByBrand.push({ name: b.name, host: b.host, sale: s.sale || '', products: n(s.products), staleOffers: n(s.staleOffer), funnels: n(s.funnel), newAds: n(s.activity && s.activity.ads), newEmails: n(s.activity && s.activity.emails) });
      } catch (e) { /* brand facts are best-effort */ }
    }
    const misses = checkMisses(text, factsByBrand);
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
