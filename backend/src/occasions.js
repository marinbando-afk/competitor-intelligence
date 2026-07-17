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

// ⚠️ DO NOT REINTRODUCE DEADLINE / FAKE-TIMER DETECTION (removed 17 Jul, founder's call).
// An earlier version flagged ads whose stated deadline they had outlived — "Today only"
// live for 52 days, "48 hours" live for 28. It worked, but the founder killed it on sight:
// "this is common sense for ecom brands, don't call out fake timers, today only callouts
// etc." Evergreen urgency is table stakes in DTC, so reporting it is noise that dilutes the
// callout that DOES matter.
//
// The OUT-OF-SEASON OCCASION check below stays — that is the founder's original ask and a
// genuinely different claim: "Black Friday" in July is a checkable falsehood about WHEN,
// not a generic urgency device. A permanent countdown is normal; a Black Friday sale eight
// months after Black Friday is not.

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

// Is a storefront announcement-bar banner an actual SALE / PROMO, or just EVERYDAY
// operational messaging? Shopify bars ROTATE several slides (a sale slide, a "free
// shipping" slide, "new arrivals", …) and we capture whichever was showing — so
// "SUMMER SALE 70% OFF" → "Free Worldwide Shipping Over $50" is a rotation, NOT a promo
// change, and free shipping is never a promo (founder, 17 Jul: "you're an ecomm expert,
// you should know this"). A real promo is a DISCOUNT, a named SALE/clearance, a BOGO, a
// gift-with-purchase, a promo code, or a named occasion — never free shipping/delivery/
// returns, "new arrivals" or "shop now".
const OPERATIONAL_FREE = /\bfree\s+(worldwide\s+|international\s+|express\s+|standard\s+|2[\s-]?day\s+|next[\s-]?day\s+|fast\s+)*(shipping|delivery|deliveries|returns?|exchanges?|ship)\b/i;
const SALE_RE = /(\d{1,3}\s*%\s*(off|discount)|\bup\s*to\s*\d{1,3}\s*%|\$\s?\d+\s*off\b|\bsave\s+(up\s+to\s+)?(\d{1,3}\s*%|\$\s?\d+)|\bsale\b|\bbogo\b|\bbuy\s*one\b|\b2\s*for\s*1\b|\bclearance\b|\bgift\s+with\s+(any\s+)?purchase\b|\bfree\s+gift\b|\bpromo\s*code\b|\bdiscount\b)/i;
export function isSaleBanner(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (SALE_RE.test(t) || occasionsIn(t).length) return true;
  // "free <something that isn't shipping/returns>" is a gift/product offer → promotional.
  if (/\bfree\b/i.test(t) && !OPERATIONAL_FREE.test(t)) return true;
  return false;
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

// STRUCTURED findings — one per (ad × claim). The prose block below and the Slack
// signal both derive from this, so the two can never drift apart or disagree.
//
// `fp` is a stable fingerprint identifying THIS claim on THIS ad, so the Slack brief can
// announce a finding exactly once. It keys on the ad's start date rather than its id: a
// re-uploaded creative making the same stale claim from the same launch date is the same
// finding, while a genuinely NEW ad reviving the claim gets a new fp and re-announces.
//
//   kind: 'occasion' — invokes an occasion that is far out of season. The ONLY kind:
//                      deadline/fake-timer detection was removed on purpose (see above).
export function offerFlags(ads, today) {
  const out = [];
  for (const a of (ads || [])) {
    const blob = [a && a.text, a && a.title, a && a.cta].filter(Boolean).join(' ');
    if (!blob) continue;
    const started = parseDay(a && a.started);
    const running = started && started <= today ? Math.round((today - started) / DAY) : null;
    const link = (a && a.link) || '';
    const sd = started ? iso(started) : '?';

    for (const label of occasionsIn(blob)) {
      const p = placeOccasion(label, today);
      if (!p || !p.stale) continue;   // in-season occasions are normal — say nothing
      // An ad LAUNCHED out of season is the damning version: not a promo left running by
      // accident, but one deliberately created months away from the occasion it names.
      const createdAfter = started ? Math.round((started - p.last) / DAY) : null;
      out.push({
        kind: 'occasion', label: p.label, started: started ? sd : null, running, link,
        last: iso(p.last), next: iso(p.next), daysSince: p.daysSince,
        monthsSince: months(p.daysSince), monthsUntil: months(p.daysUntil),
        createdAfter: createdAfter != null && createdAfter > STALE_DAYS ? createdAfter : null,
        fp: 'occasion:' + p.label + ':' + sd,
      });
    }
  }
  return out;
}

// Ground-truth block for the ads read: which live ads lean on an out-of-season occasion,
// and which assert a deadline they have already outlived. Returns '' when there's nothing
// to say, so a clean advertiser adds no noise to the prompt.
export function offerFacts(ads, today) {
  const lines = offerFlags(ads, today).map((f) => {
    const runLine = f.running == null ? '' : ' It has been running for ' + f.running + ' days (live since ' + f.started + ').';
    if (f.kind === 'occasion') {
      let l = '- OUT-OF-SEASON OFFER — a LIVE ad invokes "' + f.label + '". ' + f.label + ' last fell on ' + f.last +
        ' — ' + f.monthsSince + ' months (' + f.daysSince + ' days) BEFORE today — and does not come round again until ' +
        f.next + ', ' + f.monthsUntil + ' months away. This occasion is FAR OUT OF SEASON.' + runLine;
      if (f.createdAfter) l += ' The ad was CREATED on ' + f.started + ', ' + months(f.createdAfter) + ' months AFTER that ' + f.label + ' — it was never a real seasonal promo.';
      return l;
    }
    return '';
  }).filter(Boolean);
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
  if (!out.length) return '';
  return '\nPROMO TIMING FACTS (computed from today\'s date — ground truth, do NOT contradict):\n' + out.join('\n');
}
