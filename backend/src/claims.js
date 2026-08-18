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

// Splitting on every '.' shredded domains, prices and abbreviations — "casaandbeyond.com.au"
// became three "sentences", so a rule looking for the whole domain never saw it and the
// validator has been judging fragments. Split only at a real sentence boundary: terminator +
// whitespace + something that starts a new sentence.
function sentencesOf(t) {
  const parts = String(t || '').split(/(?<=[.!?])\s+(?=[A-Z"'“(\u2022•\-])/).map((x) => x.trim()).filter(Boolean);
  // "Dr. Annie Gonzalez" is one name, not two sentences — re-join fragments that end in a
  // common abbreviation (persona pages are full of Dr./MD/Inc.).
  const ABBR = /\b(Dr|Mr|Mrs|Ms|Prof|Sr|Jr|St|Inc|Ltd|Co|Corp|vs|etc|approx|No|Vol|Est)\.$/i;
  const out = [];
  for (const p of parts) {
    if (out.length && ABBR.test(out[out.length - 1])) out[out.length - 1] += ' ' + p;
    else out.push(p);
  }
  return out;
}

// Claim patterns. Each: what it asserts, and which fact must be true for it to be allowed.
const RULES = [
  {
    id: 'staleNew',
    // THE RULE THE FOUNDER HAD TO SHOUT FOR (6 Aug): "stop reporting insights as NEW if they
    // are not NEW". Every other rule asks "could anything be new today?" — this one asks the
    // only question that matters: is THIS THING new? Callers pass knownEntities, the domains,
    // pages and products already seen in earlier captures. Calling any of them new is banned
    // outright, regardless of how healthy today's capture is.
    re: /\b(new|newly|first|launch(ed|es|ing)?|just (added|started|introduced)|now (running|live|using)|started (using|running))\b/i,
    allow: (f, sentence) => {
      const known = f.knownEntities;
      if (!Array.isArray(known) || !known.length) return true;
      const t = String(sentence || '').toLowerCase();
      // If the sentence names something we have already seen, it is not news…
      const named = known.filter((k) => k && k.length >= 4 && t.indexOf(String(k).toLowerCase()) >= 0);
      if (!named.length) return true;
      // …UNLESS the engine itself established news INVOLVING that entity (7 Aug). Every
      // new-ad sentence names the brand's own page or domain — "three new video ads from
      // their Glov Beauty page" — and this rule was blanket-stripping all of it, which is
      // how ads reports went quiet. If every named known entity appears in a computed
      // change finding, the newness is the engine's claim, not the model's; the
      // traceability check below still verifies the sentence against those findings.
      const cf = Array.isArray(f.changeFindings) ? f.changeFindings : [];
      return named.every((k) => cf.some((c) => String(c).toLowerCase().indexOf(String(k).toLowerCase()) >= 0));
    },
    why: 'calls something NEW that appears in earlier captures — it was seen before today, so it is not new',
  },
  {
    id: 'contradictsDiff',
    // UKLASH, 3 Aug: headline "New subscription-discount sale live today" sitting directly
    // above our own panel saying "No changes since the last capture. Compared 2 Aug -> 3 Aug:
    // prices, products and sale scope are unchanged." The diff is computed from the data; a
    // read may not contradict it.
    re: /\b(new|launch(ed|es|ing)?|now live|live (today|now)|started (today|on |\d)|just (added|dropped|introduced)|first (appearance|time))\b/i,
    allow: (f) => f.noChanges !== true,
    why: 'claims something changed/launched while the computed diff for the same two days found NO changes — the read must not contradict the data panel beneath it',
  },
  {
    id: 'quietWithoutData',
    // Pannonian Padel, 5 Aug: the brief said "no new posts on social media" for a brand whose
    // Instagram/TikTok/Facebook handles were never stored — we had never looked. Reporting
    // quiet when a channel is UNMONITORED is the worst version of absence-as-evidence: it
    // tells the customer their competitor is idle when we simply have no account connected.
    re: /\b(no (new )?(posts|activity|content)|nothing new|no social activity|quiet on social|has(n't| not) posted)\b/i,
    allow: (f) => f.channelConnected === true,
    why: 'reports a channel as quiet when no account is connected for it — we never looked, so we cannot say they did not post',
  },
  {
    // Founder HARD RULE, 13 Aug: "you only say no new posts, ads or emails if it's been
    // more than 7 days without something new; within 7d say — no new xyz yesterday, most
    // recent one xyz." Callers pass daysSinceNew (from the channel's .lastNew finding).
    id: 'bareQuiet',
    re: /\bno new (ads?|posts?|emails?|creatives?|launches?|content|activity)\b/i,
    allow: (f, sentence) => {
      if (/\b(most recent|latest|last (new|one|post|ad|email|launch))\b/i.test(String(sentence || ''))) return true;
      return f.daysSinceNew != null && f.daysSinceNew > 7;
    },
    why: 'bare "no new X" is only allowed after 7+ quiet days; within a week write "no new X yesterday — most recent: …" (founder hard rule, 13 Aug)',
  },
  {
    id: 'ended',
    // a page/tactic/campaign stopped
    // "dropped" is ambiguous in English: a page can drop OUT (stopped) and a collab can
    // DROP today (released). The Oodie's "Harry Potter x The Oodie dropped today" was a
    // release and must not be read as an ending, so the release sense is excluded.
    re: /\b(dropped(?!\s+(?:today|yesterday|this|last|in\s|on\s+(?:tiktok|instagram|facebook|their|the)))|retired|went (quiet|silent|dark)|has gone (quiet|silent)|stopped running|no longer (running|active|used)|abandoned|discontinued|shut down|pulled back|wound down)\b/i,
    allow: (f) => f.canJudgeAbsence === true,
    why: 'claims something ENDED, but the capture is empty, at its collection cap, or much smaller than the previous one — absence is not evidence here',
  },
  {
    id: 'launched',
    re: /\b(launch(ed|es|ing)?|debut(ed)?|introduc(ed|ing)|rolled out|went live|now live|live (today|now)|just added|newly added|started (today|on |\d))\b/i,
    // genuineNewProduct === false means the "new" items are variants/re-listings of something
    // already on the site (Tallowed Truth) — that can never be a launch.
    allow: (f) => f.hasEarlier === true && f.canAssertNew !== false && f.genuineNewProduct !== false,
    why: 'claims something LAUNCHED, but there is no earlier capture showing it absent (a first capture makes everything look new)',
  },
  {
    id: 'firstNew',
    re: /\b(first new|their first|brand[- ]new|first (appearance|time) (in|this)|first seen (today|in monitoring))\b/i,
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
    // Casa and Beyond, 4 Aug: "Ad destination switched from .com to .com.au today". They had
    // used .com.au since 31 Jul; the 3rd and 4th captured only 3 and 2 ads out of ~30, so the
    // "switch" was which handful got sampled. A switch asserts the OLD thing is gone, which
    // a thin slice can never establish.
    re: /\b(replac(ed|es|ing)|switch(ed|es|ing)? (from|to)|swapped (for|to)|changed from|shifted (from|to)|pivot(ed)? (from|to)|moved (from|to))\b/i,
    allow: (f) => f.comparable === true && f.sampleReliable !== false,
    why: 'claims a REPLACEMENT, which needs two comparable captures from different days',
  },
  {
    id: 'priceMove',
    re: /(?:\brais(?:ed|ing)\b[^.]{0,14}\bprice\b|\bprice[sd]?\b[^.]{0,14}\b(?:rais(?:ed|ing)|increase[sd]?|rise|jump(?:ed)?|cut|drop(?:ped)?)\b|\bincreased to \$|\bnow costs? \$|\bdropped to \$|[+-]\$\d)/i,
    allow: (f) => f.priceComparable === true || f.advice === true,
    why: 'claims a PRICE MOVE without two different-day captures that both carry the product feed',
  },
  {
    id: 'completeness',
    // The DRM LAB, 6 Aug: "runs ALL ads from their own branded page". We captured 79 ads —
    // every one from their page — but a capture is what the Ad Library returned, never a
    // proven-complete inventory, and whitelisted ads from third-party pages surface only via
    // keyword search. A universal quantifier turns a sample into a census.
    re: /\b(all|every|entire|exclusively|only|none of|no other)\b[^.]{0,40}\b(ads?|creatives?|pages?|funnels?|listings?|posts?)\b|\b(ads?|creatives?|pages?)\b[^.]{0,25}\b(all|exclusively|only)\b/i,
    allow: (f, sentence) => {
      // Scoped statements are fine — the sample must be named in the same sentence.
      return /(captur|sample|we (see|hold|have)|in view|so far|of the \d+|\b\d+ ads?\b)/i.test(String(sentence || ''));
    },
    why: 'states a UNIVERSAL fact ("all ads", "every page", "only") from a capture that is a sample, not a proven-complete inventory — scope it to what was captured',
  },
  {
    id: 'inventedMechanism',
    // Bonafide, 6 Aug: "their paid social presence is either paused or below our capture
    // threshold". There is no capture threshold — we either find ads in the Ad Library or we
    // don't. Inventing a technical-sounding limit implies a system behaviour that does not
    // exist and lets a non-answer masquerade as analysis.
    re: /\b(below|under|above|beyond|outside)\s+(our|the)\s+\w*\s*(threshold|limit|cut[- ]?off|sensitivity|detection|radar)\b|\bcapture threshold\b|\bdetection threshold\b/i,
    allow: () => false,
    why: 'invents an internal mechanism ("below our capture threshold") that does not exist — say what we did and did not find, in plain terms',
  },
  {
    id: 'durationDays',
    re: /\b(running|live|active|been on)\b[^.]{0,24}\b\d+\+? days?\b/i,
    allow: () => false,
    why: 'states a running duration in days — banned; say it is active/ongoing without dating it',
  },
  {
    id: 'captureCount',
    re: /\b\d+\+? (consecutive )?captures?\b|\bsince the (last|previous) capture\b/i,
    allow: () => false,
    why: 'counts captures — internal plumbing language; use dates',
  },
  {
    // Founder, 9 Aug: "you don't need to report that something is live since XYZ, it
    // clutters the data and it's not useful" — and the date is usually just when WE (or
    // the newest ad) first appeared, not the thing's real age. Dates belong on launches.
    id: 'liveSince',
    re: /\b(live|running|active|on[- ]?site|up) since\b/i,
    allow: () => false,
    why: '"live since" dating is clutter — say it is active/unchanged; date only genuine launches ("launched <date>")',
  },
  {
    // Founder, 9 Aug: "it's not important how many ads you captured … also that number
    // could be wrong". Capture volume is plumbing; launch counts are news and stay —
    // but only when the sentence doesn't dress them in capture arithmetic.
    id: 'adCount',
    re: /\ball \d+\+? ads?\b|\b\d+\+? ads? (in|from) (today|yesterday|this week)['’]s capture\b|\btypical capture\b|\bads? captured today\b/i,
    allow: (s) => !/captur/i.test(s) && /\blaunch/i.test(s),
    why: 'cites capture volume — sample size is plumbing and may be wrong; report the creative content, count only launches',
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

// TRACEABILITY — the closing half of the findings design. Pattern rules ban known-bad
// wordings; this asks the opposite, and stronger, question: does this sentence's CHANGE claim
// correspond to something the engine actually established? A sentence asserting new/changed/
// ended must name an entity that appears in a finding of that kind, or it is not reportable.
// Present-tense description ("ads run to X") is untouched — only assertions of change.
const CHANGE_VERB = /\b(new|newly|first|launch(ed|es|ing)?|start(ed|s|ing)?|switch(ed|es|ing)?|shift(ed|s|ing)?|replac(ed|es|ing)|drop(ped)?|retir(ed|es)|stopp?(ed)?|add(ed)?|remov(ed)|introduc(ed|ing)|chang(ed|es))\b/i;
function tracesToFinding(sentence, facts) {
  const changeFindings = Array.isArray(facts.changeFindings) ? facts.changeFindings : null;
  if (!changeFindings) return true;             // caller didn't supply findings → rule inert
  if (!CHANGE_VERB.test(sentence)) return true; // not a change claim → nothing to trace
  if (!changeFindings.length) return false;     // nothing changed today, yet this claims it did
  const t = sentence.toLowerCase();
  // The sentence must share a distinctive token with at least one change finding.
  return changeFindings.some((f) => {
    const toks = String(f || '').toLowerCase().match(/[a-z0-9][a-z0-9.'’-]{4,}/g) || [];
    return toks.some((k) => t.indexOf(k) >= 0);
  });
}

export function checkClaims(text, facts = {}) {
  const out = [];
  const sentences = sentencesOf(text);
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s || SAFE.test(s)) continue;
    let flagged = false;
    for (const r of RULES) {
      if (!r.re.test(s)) continue;
      if (r.allow(facts, s)) continue;
      out.push({ rule: r.id, why: r.why, sentence: s });
      flagged = true;
      break;   // one violation per sentence is enough
    }
    if (!flagged && !tracesToFinding(s, facts)) {
      out.push({ rule: 'untraceable', why: 'asserts a change the findings engine did not establish — no computed finding supports it', sentence: s });
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
  // A strip must never leave a FRAGMENT ("…, all video, landing on bonafide.us.") — if what
  // survives no longer starts like a sentence, it is unreadable and gets dropped too.
  const kept = sentencesOf(text)
    .filter((x) => !bad.has(x))
    // A survivor opening with "(" is a parenthetical caveat whose main clause was stripped
    // ("(One ad URL tested…)" led Seranova's ads row, context-free — founder, 13 Aug).
    .filter((x) => /^[A-Z0-9"'“]/.test(x.trim()));
  for (const v of violations) console.warn('⚠ claim blocked' + (label ? ' [' + label + ']' : '') + ' (' + v.rule + '): ' + v.sentence + ' — ' + v.why);
  return { text: kept.join(' ').trim(), violations, allStripped: violations.length > 0 && !kept.length };
}
