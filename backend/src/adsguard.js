// ADS CAPTURE-HEALTH FACTS + PROMPT GUARD — computed ONCE, used twice.
//
// Until 7 Aug these facts were computed in two places inside generateInsights: once for the
// prompt guard shown to the model, once for the claim gate that runs after it. The prompt
// copy referenced three variables (`typical`, `earlierHadAds`, `knownEntities`) that only
// existed in the gate copy's scope, so building the guard threw a ReferenceError on EVERY
// run — and the surrounding best-effort catch swallowed it. Result: the model never saw the
// SAMPLE WARNING, the ALREADY-SEEN list, or the ABSENCE RULE, on any brand, ever, while the
// code that was supposed to deliver them read as if it worked. This module is the fix: one
// pure function computes the facts, both consumers read the same object, and
// test/adsguard.test.js keeps it alive.
//
// The incidents these facts exist for:
//   • Casa and Beyond (4 Aug) — ran ~30 ads/day, then two scrapes returned 3 and 2; comparing
//     only to yesterday made the 2-ad day look healthy because yesterday was already broken,
//     and the brief announced an "ad destination switch" that was really sampling noise.
//     TYPICAL volume is therefore the median of recent non-empty captures, not yesterday.
//   • Bonafide (4 Aug) — every prior capture held zero ads, so the first real capture made
//     bonafide.us look like a new funnel when it may have run for months. Newness needs a
//     prior capture that actually HELD ads; empty history proves nothing.
//   • Glov (2 Aug) / Seranova (2 Aug) — pages missing from a capped or thin capture were
//     reported as "dropped"/"gone quiet" while still running (Dr. Annie Gonzalez was in that
//     very day's capture). Absence is only evidence from a complete capture.

const domOf = (u) => String(u || '').replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '').toLowerCase();

// DETERMINISTIC backstop: the model keeps parroting a TOTAL ad count from an incomplete sample
// ("10 of 19 ads", "19 active ads") however firmly the prompt forbids it (founder flagged it 3×),
// so strip/soften total-count-of-ads phrasing from any generated text. Deltas the founder allows
// ("3 new ads", "2 ads launched this week") are left intact.
export function stripAdTotals(s) {
  if (!s) return s;
  return String(s)
    .replace(/\b\d+\s+of\s+(?:their\s+|its\s+)?\d+\s+ads\b/gi, 'many of their ads')          // "10 of 19 ads"
    .replace(/\b\d+\+?\s+(?:active|live|running|total|current)\s+ads\b/gi, 'their ads')       // "19 active ads"
    .replace(/\b(?:across|spanning|of)\s+(?:their\s+|its\s+)?\d+\+?\s+ads\b/gi, 'across their ads')   // "across 19 ads"
    .replace(/\ball\s+\d+\+?\s+ads?\b/gi, 'all their ads')                                    // "All 98 ads" (founder, 9 Aug)
    .replace(/\b\d+\+?\s+ads?\s+(?:in|from)\s+(?:today|yesterday|this week)['’]s\s+capture\b/gi, "today's captured ads")
    .replace(/\s*\((?:a\s+)?typical capture[^)]*\)/gi, '')                                    // "(typical capture is around 4)"
    .replace(/\bin\s+today['’]s\s+capture\b/gi, 'captured today');
}

// One object of capture-health facts from the recent ads snapshot rows (newest first).
// Feeds BOTH the prompt guard (adsAbsenceGuard) and the claim-gate facts in generateInsights.
export function adsCaptureFacts(rows, capN) {
  rows = Array.isArray(rows) ? rows : [];
  capN = Number(capN) || 50;
  const adsOf = (x) => ((x && x.data && x.data.ads) || []);
  const nowN = adsOf(rows[0]).length;
  const prevN = adsOf(rows[1]).length;

  // EVERYTHING WE HAVE SEEN BEFORE TODAY — landing domains and advertiser pages. Newness is
  // proven per ITEM: if it is on this list it cannot be called new, however healthy today's
  // capture looks (founder, 6 Aug: "stop reporting insights as NEW if they are not NEW").
  const known = new Set();
  for (let i = 1; i < rows.length; i++) {
    for (const a of adsOf(rows[i])) {
      const dm = domOf(a.landing);
      if (dm) known.add(dm);
      if (a.page) known.add(String(a.page));
    }
  }

  const counts = rows.map((x) => adsOf(x).length).filter((n) => n > 0).sort((a, b) => a - b);
  const typical = counts.length ? counts[Math.floor(counts.length / 2)] : 0;
  const capped = nowN >= Math.floor(capN * 0.95);
  const thin = !!(prevN && nowN < prevN * 0.6);
  const pagesNow = new Set(adsOf(rows[0]).map((a) => a.page).filter(Boolean));
  const pagesPrev = new Set(adsOf(rows[1]).map((a) => a.page).filter(Boolean));
  const vanished = [...pagesPrev].filter((p) => !pagesNow.has(p));
  const earlierHadAds = rows.slice(1).some((x) => adsOf(x).length > 0);
  const sampleReliable = !!(nowN && (!typical || nowN >= typical * 0.5) && !thin);

  return {
    nowN, prevN, typical, capped, thin, vanished,
    knownEntities: [...known].slice(0, 120),
    earlierHadAds,
    sampleReliable,
    canJudgeAbsence: !!(nowN && !capped && sampleReliable),
    hasEarlier: !!(rows[1] && rows[1].data),
    comparable: !!(rows[1] && rows[1].data && rows[0] && rows[1].day !== rows[0].day),
  };
}

// CAPTURE-HEALTH GUARD FOR THE MODEL (founder, 2 Aug — Glov: "all nine creator/persona
// pages dropped"; Seranova: "Dr. Annie Gonzalez has gone quiet" while she is in TODAY's
// capture). The deterministic drop-signal was already guarded, but the MODEL could still
// infer the same thing from a thin sample. Absence must be disarmed in the prompt too.
export function adsAbsenceGuard(cf) {
  if (!cf || !cf.nowN) return '';
  return (cf.typical && cf.nowN < cf.typical * 0.5
    ? '\nSAMPLE WARNING: today\'s capture holds only ' + cf.nowN + ' ads against a typical ' + cf.typical + ' for this brand — this is a THIN SLICE of their library, not their whole activity. Which pages, landing domains or countries appear today is largely which ads happened to be sampled. NEVER report a switch, shift, pivot or change of destination/targeting from it.'
    : '') +
    (!cf.earlierHadAds ? '\nNO EARLIER ADS CAPTURED for this brand — every previous capture was empty, so nothing you see today can be called new, a first, or a change. Describe what is running; never imply it started recently.' : '') +
    (cf.knownEntities.length ? '\nALREADY SEEN BEFORE TODAY (these are NOT new — never describe any of them as new, first, just added, or newly used): ' + cf.knownEntities.slice(0, 40).join(', ') + '.' : '') +
    '\nCAPTURE HEALTH (hard facts — obey them): today\'s capture holds ' + cf.nowN + ' ads' +
    (cf.prevN ? ' vs ' + cf.prevN + ' in the previous capture' : '') + '. ' +
    (cf.capped ? 'It is AT THE COLLECTION CAP, so it is a rolling window of their NEWEST ads, NOT their full library — older ads and the pages running them fall outside it at random. '
              : cf.thin ? 'It is much SMALLER than the previous capture, so coverage today is incomplete. ' : '') +
    (cf.vanished.length ? 'Pages present before but absent today: ' + cf.vanished.slice(0, 10).join(', ') + '. ' : '') +
    'ABSENCE RULE: you may NEVER say a page/creator/persona "dropped", "went quiet", "went silent", "stopped", "was retired" or that a tactic was "abandoned" because it is missing from today\'s capture' +
    (cf.capped || cf.thin ? ' — with a capped or reduced capture that conclusion is unsupported and has been wrong before' : '') +
    '. Report only what IS present. If the absence looks meaningful, say at most that it was "not seen in today\'s capture", never that it ended.';
}
