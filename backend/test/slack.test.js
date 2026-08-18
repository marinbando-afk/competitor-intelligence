// SLACK ADS RECAP ROW — client feedback via founder, 8 Aug: "these daily updates could be
// next level if they said the core message in the ads". The row quotes the stored ads read
// (SYNC RULE — recap, never re-derive), so this pins the pure assembly helper.
// Run: node test/slack.test.js
import { adsRecapLine, relativizeDay, briefBlocks } from '../src/slack.js';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
}

console.log('\nADS RECAP ROW:');
const ins = {
  ads: {
    summary: '5 new ads launched since 6 Aug — BUY-1-GET-1 Back-to-School push on pet-proof couch covers.',
    bullets: ['UGC videos lead: pet-hair removal demos anchored on the washable-cover promise.', 'Second bullet never shown.'],
  },
};
const line = adsRecapLine(ins);
check('summary + first bullet joined', line.includes('BUY-1-GET-1') && line.includes('UGC videos lead'));
check('only the FIRST bullet is appended', !line.includes('Second bullet'));
check('newlines and underscores collapsed (Slack italics stay intact)',
  adsRecapLine({ ads: { summary: 'core_message\nacross lines', bullets: [] } }) === 'core message across lines');
check('no ads read → no row', adsRecapLine(null) === '' && adsRecapLine({}) === '' && adsRecapLine({ ads: { bullets: ['x'] } }) === '');
const long = { ads: { summary: 'S'.repeat(280), bullets: ['B'.repeat(100)] } };
check('overlong bullet is not appended (300-char cap)', adsRecapLine(long) === 'S'.repeat(280));

// DAY RE-ANCHORING — founder, 10 Aug: the brief is read the morning after the capture,
// so "today (2026-08-09)" must become "yesterday" at delivery; real news dates stay.
console.log('\nDAY RE-ANCHORING:');
const R = (s) => relativizeDay(s, '2026-08-09', '2026-08-10');
check('"today (date)" → yesterday', R('Six new videos launched today (2026-08-09) on the Miracle Sofa Cover.') === 'Six new videos launched yesterday on the Miracle Sofa Cover.');
check('"on <capDay>" → yesterday', R('2 emails sent on 2026-08-09 — subjects…') === '2 emails sent yesterday — subjects…');
check('bare capture date → yesterday', R('Six new videos launched 2026-08-09, all branded.') === 'Six new videos launched yesterday, all branded.');
check('"today’s" → possessive', R('today’s capture').includes('yesterday’s'));
check('earlier news dates untouched', R('Launched 2026-08-05, still leading with the spec angle today.') === 'Launched 2026-08-05, still leading with the spec angle yesterday.');
check('same-day send → unchanged', relativizeDay('launched today', '2026-08-10', '2026-08-10') === 'launched today');
check('older read keeps its date', relativizeDay('sent today', '2026-08-08', '2026-08-10') === 'sent on 2026-08-08');
check('no double yesterday', !R('captured today on 2026-08-09').includes('yesterday yesterday'));

// BLOCK-KIT RENDERING — founder, 18 Aug: "text heavy… add some spacing". The text stays
// canonical; blocks add dividers between brands and trim the indents.
console.log('\nBLOCK-KIT RENDERING:');
const sample = '🛰️ *WatchBack daily* · Tue, 18 Aug\n\n*Nolan* 💡\n   *Ads:* ❗ six new videos.\n   *Website:* sale active.\n\n*Casa* ✅ no new moves\n   *Ads:* standing message.\n\n🔗 <https://watchback.ai|View the full dashboard →>';
const chunks = briefBlocks(sample);
check('one chunk for a small brief', Array.isArray(chunks) && chunks.length === 1);
const bl = chunks[0];
check('header renders as context', bl[0].type === 'context');
check('a divider precedes every brand', bl.filter((x) => x.type === 'divider').length === 2);
check('brand rows lose their indent', bl.some((x) => x.type === 'section' && x.text.text.includes('\n*Ads:* ❗ six new videos.')));
// VARIANT C (19 Aug): a blank row splits saying (Ads·Social) from doing (Website·Email)…
check('gap inserted before the doing group', bl.some((x) => x.type === 'section' && x.text.text.includes('six new videos.\n\n*Website:*')));
// …but never when the brand has no saying rows above (nothing to split from).
const soloWeb = briefBlocks('head\n\n*Brand* ✅\n   *Website:* sale active.\n\n🔗 <https://x|y>');
check('no gap for a website-only block', soloWeb[0].some((x) => x.type === 'section' && !x.text.text.includes('\n\n*Website:*')));
check('footer link is a context block', bl[bl.length - 1].type === 'context' && bl[bl.length - 1].elements[0].text.includes('watchback.ai'));
const big = ['head'].concat(Array.from({ length: 40 }, (_, i) => '*B' + i + '* ✅\n   *Ads:* x.')).join('\n\n');
check('40 brands chunk under the 50-block cap', briefBlocks(big).every((c) => c.length <= 48) && briefBlocks(big).length > 1);
check('unexpected shape falls back to null (plain text)', briefBlocks('just one line') === null);

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
