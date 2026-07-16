// ── Priority-ordered daily signals for the Slack brief ────────────────────────
// Detects, per competitor, the moves the founder cares about MOST, in strict
// priority order:
//   1. SALE change      — a sale started/ended/changed, or the promo banner changed
//   2. NEW funnel       — a landing page / domain in an ad we hadn't seen before
//   3. NEW Facebook page— the brand advertising from a page it wasn't using before
//   4. NEW products     — products added to the storefront
//   5. NEW ad angle     — a fresh creative whose angle hasn't run in the last 2 weeks
//
// Everything is grounded in captured data (no invention). Detection is deliberately
// CONSERVATIVE — when unsure whether something is genuinely new, we stay silent
// rather than cry wolf (same precision-first discipline as ad attribution).

import { recentSnapshots, allSnapshots } from './snapshots.js';
import { diffWebsite } from './website.js';
import { adsChanges } from './ads.js';

const DAY = 86400000;
const ANGLE_WINDOW_DAYS = 14;   // "at least the last 2 weeks"

// A real promo banner is a short headline. Older snapshots may hold a model's non-answer
// prose ("I don't see any active promotion…") — never compare those as if they were
// banners, or we'd report a bogus "Promo changed" between two pieces of explanation.
function bannerOk(s) {
  const t = String(s || '').trim();
  if (!t) return false;
  if (/^(i (don'?t|do not|can'?t|cannot)\b|there (is|are) no\b|no (active|visible|current)?\s*(promotion|promo|sale|offer|banner)|none\b|n\/?a\b|unable\b)/i.test(t)) return false;
  return t.split(/\s+/).length <= 16 && t.length <= 120;
}

// Normalise an angle to a comparable fingerprint: significant lowercase word-stems,
// sorted and de-duplicated. Short/stopword tokens are dropped so wording drift
// ("scarcity urgency" vs "urgency + scarcity") maps to the same set.
const STOP = new Set(['the', 'and', 'for', 'with', 'your', 'you', 'our', 'that', 'this', 'from', 'into', 'over', 'via', 'off', 'per', 'ad', 'ads', 'angle', 'a', 'an', 'of', 'to', 'on', 'in', 'is', 'it', 'as', 'at', 'by']);
function angleTokens(s) {
  return [...new Set(String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)
    .filter((w) => w.length >= 4 && !STOP.has(w)))];
}
// Two angles count as the SAME when their significant tokens overlap heavily (Jaccard
// ≥ 0.5) — biased toward "already seen" so we don't over-report reworded repeats.
function sameAngle(aTok, bTok) {
  if (!aTok.length || !bTok.length) return false;
  const bset = new Set(bTok);
  const inter = aTok.filter((t) => bset.has(t)).length;
  return inter / (aTok.length + bTok.length - inter) >= 0.5;
}

// Ad angles seen in the [today-14d, yesterday] window (excludes today).
async function priorAngles(host, todayStr) {
  const cutoff = new Date(Date.parse(todayStr) - ANGLE_WINDOW_DAYS * DAY).toISOString().slice(0, 10);
  const snaps = await allSnapshots(host, 'ads');   // oldest → newest
  const seen = [];
  for (const s of snaps) {
    if (!s.day || s.day >= todayStr || s.day < cutoff) continue;
    for (const a of (s.data && s.data.ads) || []) {
      const t = angleTokens(a.angle);
      if (t.length) seen.push(t);
    }
  }
  return seen;
}

// #5 — genuinely NEW creatives today whose angle hasn't run in the last 2 weeks.
async function newAngles(host, freshAds, todayStr) {
  if (!freshAds || !freshAds.length) return [];
  const prior = await priorAngles(host, todayStr);
  const out = [], emitted = [];
  for (const a of freshAds) {
    const tok = angleTokens(a.angle);
    if (!tok.length) continue;                                   // no angle read → can't claim it's new
    if (prior.some((p) => sameAngle(tok, p))) continue;          // ran within the window → not new
    if (emitted.some((p) => sameAngle(tok, p))) continue;        // already surfaced this round
    emitted.push(tok);
    out.push({ angle: a.angle, link: a.link || '', image: a.image || '' });
    if (out.length >= 2) break;   // a genuinely new angle is rare — surface at most the top 2
  }
  return out;
}

// Detect everything for one host. Returns a structured object; empty arrays / null
// mean "no signal". Never throws — a subsystem with no data just yields nothing.
export async function dailySignals(host) {
  const out = { sale: null, funnel: [], fbPage: [], products: [], angle: [] };
  if (!host) return out;
  const todayStr = new Date().toISOString().slice(0, 10);

  // 1 + 4) Website: sale change (count or promo banner) and new products.
  try {
    const web = await recentSnapshots(host, 'website', 2);
    const cur = web[0] && web[0].data, prev = web[1] && web[1].data;
    if (cur && prev && cur.summary && prev.summary) {
      const diffs = diffWebsite(prev.summary, cur.summary) || [];
      const saleLine = diffs.find((d) => /^Sale (started|ended|widened|narrowed)/i.test(d));
      const bA = bannerOk(prev.banner) ? String(prev.banner).trim() : '';
      const bB = bannerOk(cur.banner) ? String(cur.banner).trim() : '';
      if (saleLine) out.sale = saleLine;
      else if (bA && bB && bA.toLowerCase() !== bB.toLowerCase()) out.sale = `Promo changed — “${bA}” → “${bB}”`;
      else if (!bA && bB) out.sale = `Promo went live — “${bB}”`;
      // (a banner disappearing is not reported on its own — often just a rotation/JS timing blip)
      out.products = diffs.filter((d) => /new product/i.test(d));
    }
  } catch (e) { /* no website signal */ }

  // 2 + 3 + 5) Ads: new funnel, new Facebook page, new angle.
  try {
    const adSnap = (await recentSnapshots(host, 'ads', 1))[0];
    const todayAds = (adSnap && adSnap.data && Array.isArray(adSnap.data.ads)) ? adSnap.data.ads : [];
    if (todayAds.length) {
      const ch = await adsChanges(host, todayAds);
      if (ch && !ch.baseline) {
        out.funnel = (ch.signals.landings || []).filter((l) => l && l.domain);   // [{domain, url}]
        out.fbPage = (ch.signals.pages || []).filter(Boolean);                    // [pageName]
        out.angle = await newAngles(host, ch.newAds || [], todayStr);
      }
    }
  } catch (e) { /* no ads signal */ }

  return out;
}

// True when any signal fired.
export function hasSignal(s) {
  return !!(s && (s.sale || (s.funnel && s.funnel.length) || (s.fbPage && s.fbPage.length) || (s.products && s.products.length) || (s.angle && s.angle.length)));
}

// Render one brand's signals as Slack mrkdwn lines, in PRIORITY ORDER.
// Returns [] when nothing fired (caller shows "all quiet").
//
// Deliberately spare: the 💡/✅ on the brand line already carries the at-a-glance status,
// so a per-line icon would double-code what the words say — and a repeated 🎯 stops being
// an anchor anyway. Sale/product strings already name themselves ("Sale widened — …",
// "2 new products: …"), so they get NO label prefix or it reads twice. Ad URLs are long
// enough to wrap onto their own line, so they're linked behind short text instead.
export function signalLines(s) {
  if (!s) return [];
  const lines = [];
  const link = (u, label) => (u ? ' — <' + u + '|' + label + ' ↗>' : '');
  if (s.sale) lines.push(s.sale);
  for (const f of (s.funnel || [])) lines.push('New funnel: ' + f.domain + link(f.url, 'open'));
  for (const p of (s.fbPage || [])) lines.push('New FB page advertising: ' + p);
  for (const pr of (s.products || [])) lines.push(pr);
  for (const a of (s.angle || [])) lines.push('New angle (2wk+): ' + a.angle + link(a.link, 'view ad'));
  return lines;
}
