// SLACK ADS RECAP ROW — client feedback via founder, 8 Aug: "these daily updates could be
// next level if they said the core message in the ads". The row quotes the stored ads read
// (SYNC RULE — recap, never re-derive), so this pins the pure assembly helper.
// Run: node test/slack.test.js
import { adsRecapLine, relativizeDay } from '../src/slack.js';

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

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
