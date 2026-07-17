// Stale-occasion / fake-urgency detection.
//
// A sale tied to an occasion that passed months ago is not a sale — it is permanent
// discounting wearing a holiday costume, and it is one of the most telling things a
// competitor can leak: it means the "discount" is really their price, their margin
// structure tolerates it, and their urgency is theatre. Glov ran "Black Friday Sale:
// Up to 90% OFF — Today only" as a NEW ad launched 26 May 2026 and kept it live for
// 52 days (found 17 Jul 2026). The reads flattened that to "an aggressive 90%-off
// sale claim" for one reason: nothing ever told the model what today's date was, so
// "[2026-05-26]" was an inert string and Black Friday could not be placed in time.
//
// Date arithmetic is done HERE, in code, and handed to the model as ground truth —
// models are unreliable at it, and the house rule is to miss a call rather than make
// a wrong one. Only occasions with a RELIABLY computable date are dated. Vague or
// hemisphere-dependent ones ("Summer Sale") and ones whose date moves year to year or
// by country (Prime Day, Mother's Day) are deliberately NOT dated — an Australian
// brand running a "Summer Sale" in January is correct, not stale.

const DAY = 86400000;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// An occasion is only STALE when it is far from today in BOTH directions — a sale
// still running two weeks after Black Friday is a normal extended promo, not a lie.
const STALE_DAYS = 45;

function utc(y, m, d) { return new Date(Date.UTC(y, m, d)); }
function iso(d) { return d.toISOString().slice(0, 10); }
function parseDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '').trim());
  return m ? utc(+m[1], +m[2] - 1, +m[3]) : null;
}
function pretty(d) { return DAYS[d.getUTCDay()] + ', ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear(); }

// nth <weekday> of a month, e.g. nth(2025, 10, 4, 4) = 4th Thursday of November 2025.
function nth(year, month, weekday, n) {
  const first = utc(year, month, 1);
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return utc(year, month, 1 + offset + (n - 1) * 7);
}
function lastWeekday(year, month, weekday) {
  const last = utc(year, month + 1, 0);
  return utc(year, month, last.getUTCDate() - ((last.getUTCDay() - weekday + 7) % 7));
}
// US Thanksgiving = 4th Thursday of November; Black Friday is the day after.
function blackFriday(year) { return new Date(nth(year, 10, 4, 4).getTime() + DAY); }
// Anonymous Gregorian computus.
function easter(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return utc(year, month - 1, day);
}

// Each entry: the phrases that name it, and a function giving its date in a given year.
// `label` is the canonical name used in the facts block.
const OCCASIONS = [
  { label: 'Black Friday', re: /\bblack\s?friday\b|\bbfcm\b|\bblack\s?fri\b/i, date: blackFriday },
  { label: 'Cyber Monday', re: /\bcyber\s?monday\b/i, date: (y) => new Date(blackFriday(y).getTime() + 3 * DAY) },
  { label: 'Cyber Week', re: /\bcyber\s?week\b/i, date: (y) => new Date(blackFriday(y).getTime() + 3 * DAY) },
  { label: 'Christmas', re: /\bchristmas\b|\bxmas\b/i, date: (y) => utc(y, 11, 25) },
  { label: 'Boxing Day', re: /\bboxing\s?day\b/i, date: (y) => utc(y, 11, 26) },
  { label: "New Year's", re: /\bnew\s?year'?s?\b|\bnye\b/i, date: (y) => utc(y, 0, 1) },
  { label: "Valentine's Day", re: /\bvalentine'?s?\b|\bv-?day\b/i, date: (y) => utc(y, 1, 14) },
  { label: 'Easter', re: /\beaster\b/i, date: easter },
  { label: 'Halloween', re: /\bhalloween\b/i, date: (y) => utc(y, 9, 31) },
  { label: 'Singles Day', re: /\bsingles'?\s?day\b|\b11\.11\b/i, date: (y) => utc(y, 10, 11) },
  { label: 'Independence Day (4th of July)', re: /\b4th\s?of\s?july\b|\bjuly\s?4(th)?\b|\bindependence\s?day\b|\bfourth\s?of\s?july\b/i, date: (y) => utc(y, 6, 4) },
  { label: 'Memorial Day', re: /\bmemorial\s?day\b/i, date: (y) => lastWeekday(y, 4, 1) },
  { label: 'Labor Day', re: /\blabou?r\s?day\b/i, date: (y) => nth(y, 8, 1, 1) },
  { label: "St. Patrick's Day", re: /\bst\.?\s?patrick'?s?\b|\bpaddy'?s\b/i, date: (y) => utc(y, 2, 17) },
];

// Deadline claims, in two tiers — because they are NOT equally damning and reporting
// them in identical language would cheapen the real finding.
//
//   hard: a SPECIFIC, falsifiable promise ("Today only", "48 hours"). If the ad has
//         outlived it, the claim is simply untrue — that is the quotable signal.
//   soft: marketing boilerplate ("Limited time", "Last chance"). Vague by design and
//         near-universal in DTC, so it is NOT evidence of a lie. Only worth a mention
//         once the duration makes it plainly decorative, and worded as such.
const URGENCY = [
  { re: /\btoday\s?only\b/i, label: 'Today only', days: 1, hard: true },
  { re: /\bends\s?(tonight|today)\b/i, label: 'Ends tonight', days: 1, hard: true },
  { re: /\b(final|last)\s?(few\s?)?hours\b/i, label: 'Final hours', days: 1, hard: true },
  { re: /\b24\s?hours?\b/i, label: '24 hours', days: 1, hard: true },
  { re: /\b48\s?hours?\b/i, label: '48 hours', days: 2, hard: true },
  { re: /\b72\s?hours?\b/i, label: '72 hours', days: 3, hard: true },
  { re: /\bthis\s?weekend\s?only\b/i, label: 'This weekend only', days: 3, hard: true },
  { re: /\bends\s?(this\s?)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i, label: 'Ends this week', days: 7, hard: true },
  { re: /\blast\s?chance\b/i, label: 'Last chance', days: 7, hard: false },
  { re: /\b(ends|expires)\s?soon\b/i, label: 'Ends soon', days: 7, hard: false },
  { re: /\bwhile\s?stocks?\s?last\b/i, label: 'While stocks last', days: 14, hard: false },
  { re: /\blimited\s?time\b/i, label: 'Limited time', days: 14, hard: false },
];
// A soft claim only earns a line once it has run long enough to be self-evidently empty.
const SOFT_DAYS = 90;

function months(days) { return Math.round((days / 30.44) * 10) / 10; }

// Place a named occasion in time relative to `today`.
// Returns { label, last, next, daysSince, daysUntil, stale }.
export function placeOccasion(label, today) {
  const o = OCCASIONS.find((x) => x.label === label);
  if (!o) return null;
  const y = today.getUTCFullYear();
  const candidates = [o.date(y - 1), o.date(y), o.date(y + 1)].sort((a, b) => a - b);
  const past = candidates.filter((d) => d <= today);
  const future = candidates.filter((d) => d > today);
  const last = past[past.length - 1], next = future[0];
  if (!last || !next) return null;
  const daysSince = Math.round((today - last) / DAY);
  const daysUntil = Math.round((next - today) / DAY);
  return { label, last, next, daysSince, daysUntil, stale: daysSince > STALE_DAYS && daysUntil > STALE_DAYS };
}

// Every occasion named in a blob of copy.
export function occasionsIn(text) {
  const t = String(text || '');
  return OCCASIONS.filter((o) => o.re.test(t)).map((o) => o.label);
}

// Every deadline claim in a blob of copy.
export function urgencyIn(text) {
  const t = String(text || '');
  return URGENCY.filter((u) => u.re.test(t)).map((u) => ({ label: u.label, days: u.days, hard: u.hard }));
}

export function todayLine(today) {
  return 'TODAY IS ' + iso(today) + ' (' + pretty(today) + ').';
}

// One human-readable stale-occasion sentence, shared by the ads and website blocks.
function staleSentence(p) {
  return p.label + ' last fell on ' + iso(p.last) + ' — ' + months(p.daysSince) + ' months (' + p.daysSince +
    ' days) BEFORE today — and does not come round again until ' + iso(p.next) + ', ' + months(p.daysUntil) +
    ' months away. This occasion is FAR OUT OF SEASON.';
}

// Ground-truth block for the ads read: which live ads lean on an out-of-season occasion,
// and which assert a deadline they have already outlived. Returns '' when there's nothing
// to say, so a clean advertiser adds no noise to the prompt.
export function offerFacts(ads, today) {
  const lines = [];
  for (const a of (ads || [])) {
    const blob = [a && a.text, a && a.title, a && a.cta].filter(Boolean).join(' ');
    if (!blob) continue;
    const started = parseDay(a && a.started);
    const running = started && started <= today ? Math.round((today - started) / DAY) : null;
    const runLine = running == null ? '' : ' It has been running for ' + running + ' days (live since ' + iso(started) + ').';

    for (const label of occasionsIn(blob)) {
      const p = placeOccasion(label, today);
      if (!p || !p.stale) continue;   // in-season occasions are normal — say nothing
      let l = 'OUT-OF-SEASON OFFER — a LIVE ad invokes "' + p.label + '". ' + staleSentence(p) + runLine;
      // An ad LAUNCHED out of season is the damning version: not a promo left running by
      // accident, but one deliberately created months away from the occasion it names.
      if (started) {
        const gap = Math.round((started - p.last) / DAY);
        if (gap > STALE_DAYS) l += ' The ad was CREATED on ' + iso(started) + ', ' + months(gap) + ' months AFTER that ' + p.label + ' — it was never a real seasonal promo.';
      }
      lines.push('- ' + l);
    }

    for (const u of urgencyIn(blob)) {
      if (running == null) continue;
      if (u.hard) {
        if (running <= Math.max(u.days * 3, 7)) continue;   // a short run is honest
        lines.push('- FAKE DEADLINE — a LIVE ad promises "' + u.label + '" but has been running continuously for ' +
          running + ' days (live since ' + iso(started) + '). The deadline is specific and has been outlived many times over: the claim is simply untrue and the urgency is permanent.');
      } else {
        if (running < SOFT_DAYS) continue;   // vague urgency is normal DTC boilerplate — stay quiet
        lines.push('- EVERGREEN URGENCY (minor) — a LIVE ad has claimed "' + u.label + '" for ' + running +
          ' days straight (live since ' + iso(started) + '). This is vague boilerplate rather than a broken promise, but at this duration it is decorative. Worth at most a passing clause — do NOT lead with it or call it a lie.');
      }
    }
  }
  if (!lines.length) return '';
  // Identical ads produce identical lines; the model gains nothing from seeing them twice.
  return '\nOFFER TIMING FACTS (computed from today\'s date — ground truth, do NOT contradict, do NOT recompute):\n' + [...new Set(lines)].join('\n');
}

// Same check for the storefront's promo banner, which is where a sale usually lives.
export function bannerFacts(banner, today) {
  const out = [];
  for (const label of occasionsIn(banner)) {
    const p = placeOccasion(label, today);
    if (!p || !p.stale) continue;
    out.push('- OUT-OF-SEASON PROMO — the live on-site banner invokes "' + p.label + '". ' + staleSentence(p));
  }
  // Only a SPECIFIC banner deadline is worth a line; "Be quick!"-style boilerplate is not,
  // and we have no start date for a banner, so we never assert it has been outlived.
  for (const u of urgencyIn(banner)) {
    if (!u.hard) continue;
    out.push('- The live on-site banner asserts a specific deadline ("' + u.label + '") — note whether the same deadline was present in earlier captures; if so it is not real.');
  }
  if (!out.length) return '';
  return '\nPROMO TIMING FACTS (computed from today\'s date — ground truth, do NOT contradict):\n' + out.join('\n');
}
