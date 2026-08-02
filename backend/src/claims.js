// CLAIM VALIDATOR — the last gate before a read reaches a customer.
//
// Every trust failure so far has been the same family: a sentence asserting that something
// STARTED, ENDED, or is NEW, built on absence or on a diff the data cannot support.
//   • Glov      "all nine creator/persona pages dropped"      — capture was at its cap
//   • Seranova  "Dr. Annie Gonzalez has gone quiet"           — she is in today's capture
//   • Tallowed  "Freedom Field Balm launched today"           — listed every day since 15 Jul
//   • Casa      "50% Off Clearance Sale launched today"       — first day of monitoring
//   • Froya     "'1M Jars Sold' went live today"              — partial read of an old banner
//   • CurrentBody "raised in price today (29 Jul to 29 Jul)"  — same-day pair, no product feed
//
// Prompt rules alone never held: they were followed on one code path and ignored on another.
// So this is DETERMINISTIC code. It reads the generated text, finds claims of those types,
// and checks each against the facts of the capture it came from. Unsupported sentences are
// removed before storage — the model does not get to decide.

const SENT = /[^.!?]+[.!?]*/g;

// Claim patterns. Each: what it asserts, and which fact must be true for it to be allowed.
const RULES = [
  {
    id: 'ended',
    // a page/tactic/campaign stopped
    re: /\b(dropped|retired|went (quiet|silent|dark)|has gone (quiet|silent)|stopped running|no longer (running|active|used)|abandoned|discontinued|shut down|pulled back|wound down)\b/i,
    allow: (f) => f.canJudgeAbsence === true,
    why: 'claims something ENDED, but the capture is empty, at its collection cap, or much smaller than the previous one — absence is not evidence here',
  },
  {
    id: 'launched',
    re: /\b(launch(ed|es|ing)?|debut(ed)?|introduc(ed|ing)|rolled out|went live|just added|newly added)\b/i,
    // genuineNewProduct === false means the "new" items are variants/re-listings of something
    // already on the site (Tallowed Truth) — that can never be a launch.
    allow: (f) => f.hasEarlier === true && f.canAssertNew !== false && f.genuineNewProduct !== false,
    why: 'claims something LAUNCHED, but there is no earlier capture showing it absent (a first capture makes everything look new)',
  },
  {
    id: 'firstNew',
    re: /\b(first new|their first|brand[- ]new)\b/i,
    allow: (f) => f.hasEarlier === true && f.canAssertNew !== false && f.genuineNewProduct !== false,
    why: 'claims a FIRST/NEW milestone the captures cannot establish',
  },
  {
    id: 'newProduct',
    re: /\bnew (product|sku)s?\b/i,
    allow: (f) => f.genuineNewProduct === true,
    why: 'calls something a NEW PRODUCT when the added listings are variants or re-listings of a product already on the site',
  },
  {
    id: 'replaced',
    re: /\b(replac(ed|es|ing)|switched (from|to)|swapped (for|to)|changed from)\b/i,
    allow: (f) => f.comparable === true,
    why: 'claims a REPLACEMENT, which needs two comparable captures from different days',
  },
  {
    id: 'priceMove',
    re: /(?:\brais(?:ed|ing)\b[^.]{0,14}\bprice\b|\bprice[sd]?\b[^.]{0,14}\b(?:rais(?:ed|ing)|increase[sd]?|rise|jump(?:ed)?|cut|drop(?:ped)?)\b|\bincreased to \$|\bnow costs? \$|\bdropped to \$|[+-]\$\d)/i,
    allow: (f) => f.priceComparable === true,
    why: 'claims a PRICE MOVE without two different-day captures that both carry the product feed',
  },
  {
    id: 'durationDays',
    re: /\b(running|live|active|been on)\b[^.]{0,24}\b\d+\+? days?\b/i,
    allow: () => false,
    why: 'states a running duration in days — banned; give the start date instead',
  },
  {
    id: 'captureCount',
    re: /\b\d+\+? (consecutive )?captures?\b|\bsince the (last|previous) capture\b/i,
    allow: () => false,
    why: 'counts captures — internal plumbing language; use dates',
  },
  {
    id: 'guessIdentity',
    re: /\b(most likely|probably (from|one of)|presumably|could be (from )?(one of )?either)\b/i,
    allow: () => false,
    why: 'guesses an identity instead of naming it from the facts or admitting it is not in the sample',
  },
];

// Sentences that merely REPORT the limitation are always fine, even if they contain a keyword
// ("not seen in today's capture", "already running when monitoring began").
// NOTE the bare "monitoring began" is deliberately NOT here: Tallowed Truth's false launch
// ("...their first new product since monitoring began 15 Jul") name-checked the limitation
// inside the very sentence that broke the rule, and a blanket exemption let it through.
const SAFE = /\b(not seen in|already running when monitoring began|no earlier capture|cannot confirm|we cannot|true start date unknown|rolling window|outside (the|our) capture)\b/i;

export function checkClaims(text, facts = {}) {
  const out = [];
  const sentences = String(text || '').match(SENT) || [];
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s || SAFE.test(s)) continue;
    for (const r of RULES) {
      if (!r.re.test(s)) continue;
      if (r.allow(facts)) continue;
      out.push({ rule: r.id, why: r.why, sentence: s });
      break;   // one violation per sentence is enough
    }
  }
  return out;
}

// Remove unsupported sentences. Returns the cleaned text plus what was removed, so callers
// can log it (a silent strip would just be a different kind of silent failure).
export function enforceClaims(text, facts = {}, label = '') {
  const violations = checkClaims(text, facts);
  if (!violations.length) return { text: String(text || ''), violations };
  const bad = new Set(violations.map((v) => v.sentence));
  const kept = (String(text).match(SENT) || []).map((x) => x.trim()).filter((x) => x && !bad.has(x));
  for (const v of violations) console.warn('⚠ claim blocked' + (label ? ' [' + label + ']' : '') + ' (' + v.rule + '): ' + v.sentence + ' — ' + v.why);
  return { text: kept.join(' ').trim(), violations };
}
