// rulecheck.js — the DELIVERY GATE. Every founder rule that can be checked mechanically
// lives here as code, with a rule id matching RULES.md. Nothing AI-written ships to a
// user-facing surface without passing checkText(); a line that cannot be scrubbed clean
// falls back to deterministic text and the violation is QA-logged.
//
// Why this file exists (founder, 12 Aug): rules that lived as prompt sentences decayed —
// the model follows each one ~95-98% of the time, which across dozens of rules × brands ×
// days produces violations every single day. Rules that became code (UTM scrubber, ad-total
// backstop) stopped recurring. So: every enforceable rule becomes a check here, and every
// check has a regression test. A correction that only lands in a prompt is not a fix.

// ── individual checks ─────────────────────────────────────────────────────────
// Each returns null (clean) or a violation string. Kept tiny and pure for testing.

const CHECKS = [
  // R-URL-01 (founder, 9-10 Aug): never ship query strings / UTM junk in any URL.
  { id: 'R-URL-01', why: 'URL with query string / UTM parameters',
    test: (t) => /https?:\/\/[^\s"'<>]*\?[^\s"'<>]*(utm_|fbclid|gclid|ref=|mc_)/i.test(t) || /\b[\w.-]+\.[a-z]{2,}\/[^\s"'<>]*\?[^\s"'<>]*utm_/i.test(t) },

  // R-ADS-01 (founder, standing): never state a competitor's active-ad total or capture
  // volume ("79 active", "all 98 ads in today's capture", "X of Y ads"). Launch counts
  // ("6 new ads launched") are news and allowed.
  { id: 'R-ADS-01', why: 'active-ad total or capture volume',
    test: (t) => /\b\d+\s+active\b(?!\s+(day|week|month))/i.test(t) || /\ball\s+\d+\s+(captured\s+)?ads\b/i.test(t) || /\b\d+\s+of\s+\d+\s+ads\b/i.test(t) || /\bcapture\s+(is|was|of)\s+\d+\b/i.test(t) },

  // R-DATE-02 (founder, 9 Aug): never date how long an ad/offer has been running.
  { id: 'R-DATE-02', why: '"live/running since <date>" phrasing',
    test: (t) => /\b(live|running)\s+since\s+\d{4}-\d{2}-\d{2}/i.test(t) },

  // R-TEXT-01 (founder, 12 Aug): no undecoded quoted-printable or broken bytes.
  { id: 'R-TEXT-01', why: 'undecoded quoted-printable / broken characters',
    test: (t) => /=[0-9A-F]{2}=[0-9A-F]{2}/i.test(t) || t.includes('�') },

  // R-TEXT-02 (founder, 12 Aug): no dangling clause labels from truncation
  // ("…; newest opens." with the payload gone, a trailing colon, an orphan dash).
  { id: 'R-TEXT-02', why: 'dangling clause label / truncation artifact',
    test: (t) => /(opens|opening|reads|hook|latest|newest)[:.]?\s*$/i.test(t.replace(/["'”’)\]]+$/, '').trim()) || /[;:—–]\s*$/.test(t.trim()) || /\bthe\s+\d+…$/.test(t.trim()) },

  // R-TEXT-03: no template/JS junk ever reaches a user surface.
  { id: 'R-TEXT-03', why: 'placeholder junk (undefined/null/NaN/[object)',
    test: (t) => /\bundefined\b|\[object |\bNaN\b|\bnull\b(?![a-z])/.test(t) },

  // R-QUOTE-01 (founder, 10 Aug — clipped verdicts shipped context-free nonsense):
  // quotes and parens must be balanced.
  { id: 'R-QUOTE-01', why: 'unbalanced quotes or parentheses',
    test: (t) => ((t.match(/"/g) || []).length % 2 === 1) || ((t.match(/\(/g) || []).length !== (t.match(/\)/g) || []).length) || ((t.match(/“/g) || []).length !== (t.match(/”/g) || []).length) },

  // R-PHRASE-01 (founder, exact-wording rule): page-like campaigns are "optimised for
  // Facebook page likes", never "sends traffic to Facebook's login page".
  { id: 'R-PHRASE-01', why: 'banned phrasing: traffic to Facebook login page',
    test: (t) => /facebook[’']?s?\s+login\s+page/i.test(t) },

  // R-PHRASE-02 (founder taxonomy): never a vague "third-party page" — it is a
  // PARTNERSHIP, WHITELISTING or BRANDED ad per the taxonomy.
  { id: 'R-PHRASE-02', why: 'vague "third-party page" instead of taxonomy term',
    test: (t) => /third[- ]party page/i.test(t) },

  // R-CLAIM-01 (founder, 12 Aug — casaandbeyond): a redirect claim must be scoped to the
  // exact checked URL, never "domain X redirects".
  { id: 'R-CLAIM-01', why: 'domain-wide redirect claim',
    test: (t) => /\bdomain\s+\S+\s+(now\s+)?redirects\b/i.test(t) },

  // R-TEXT-04 (founder, 13 Aug — Seranova): a line that OPENS with a parenthetical is a
  // caveat whose main clause was stripped upstream ("(One ad URL tested…)") — context-free
  // and meaningless to the reader.
  { id: 'R-TEXT-04', why: 'orphaned parenthetical caveat leads the line',
    test: (t) => /^\s*\(/.test(t) },
];

// ISO dates in the SLACK BRIEF specifically: allowed only for genuine launch/check dates
// ("launched 2026-08-05", "checked on 2026-08-11") or explicit ranges ("2026-08-10 →").
// Everything else must be relativized ("yesterday"). App reads keep dates. R-DATE-01.
function isoDateViolation(t) {
  const re = /\d{4}-\d{2}-\d{2}/g;
  let m;
  while ((m = re.exec(t))) {
    const before = t.slice(Math.max(0, m.index - 24), m.index);
    const after = t.slice(m.index + 10, m.index + 14);
    if (/launch(ed)?\s*$|checked on\s*$|since\s*$|between\s*$|and\s*$|→\s*$|\(\s*$/i.test(before)) continue;
    if (/^\s*(→|to\b)/.test(after)) continue;
    return true;
  }
  return false;
}

// ── public API ────────────────────────────────────────────────────────────────

// checkText(text, {surface}) → array of {id, why}. surface: 'slack' | 'app' | 'any'.
export function checkText(text, opts = {}) {
  const t = String(text || '');
  if (!t.trim()) return [];
  const out = [];
  for (const c of CHECKS) { try { if (c.test(t)) out.push({ id: c.id, why: c.why }); } catch (e) { /* a broken check must never block delivery */ } }
  if (opts.surface === 'slack' && isoDateViolation(t)) out.push({ id: 'R-DATE-01', why: 'raw ISO date in brief (should be relativized)' });
  // R-PROV-01 (founder, 12 Aug): the brief is DAILY — "vs yesterday" is implicit, so a
  // stated comparison window ("compared 2026-08-11 → 2026-08-12", any date→date range)
  // is pure confusion and never ships in Slack. Provenance belongs in evidence fields.
  if (opts.surface === 'slack' && (/\d{4}-\d{2}-\d{2}\s*(?:→|->)\s*\d{4}-\d{2}-\d{2}/.test(t) || /\bcompared\s+\d{4}-\d{2}-\d{2}/i.test(t))) {
    out.push({ id: 'R-PROV-01', why: 'comparison window in brief (daily cadence makes it implicit)' });
  }
  return out;
}

// gateLine(text, fallback, {surface, qa, brand, channel}) → text that is SAFE to ship.
// Order: original → violations? → fallback (deterministic) → violations there too? →
// generic stub. Every downgrade is recorded on the qa collector for the Slack QA ping.
export function gateLine(text, fallback, opts = {}) {
  const qa = opts.qa || null;
  const v1 = checkText(text, opts);
  if (!v1.length) return { text, downgraded: false };
  if (qa) qa.push({ brand: opts.brand || '', channel: opts.channel || '', rules: v1.map((x) => x.id), sample: String(text || '').slice(0, 140) });
  const fb = String(fallback || '').trim();
  if (fb && !checkText(fb, opts).length) return { text: fb, downgraded: true };
  return { text: 'update captured — open the dashboard for the full read.', downgraded: true };
}

export const RULE_IDS = CHECKS.map((c) => c.id).concat(['R-DATE-01', 'R-PROV-01']);
