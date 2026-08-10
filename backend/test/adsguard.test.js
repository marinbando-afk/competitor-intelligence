// ADS CAPTURE-HEALTH REGRESSION — the guard that silently never ran.
//
// On 7 Aug we found the ads prompt guard had thrown a ReferenceError on EVERY run since the
// findings-first rewrite: it referenced variables that only existed in the claim gate's copy
// of the same maths, and its best-effort catch swallowed the crash. The model therefore never
// saw the SAMPLE WARNING, the ALREADY-SEEN list or the ABSENCE RULE — while the code read as
// if it worked. These fixtures pin the now-shared facts + guard (src/adsguard.js) so that
// failure mode cannot come back silently. Run: node test/adsguard.test.js
import { adsCaptureFacts, adsAbsenceGuard, stripAdTotals, stripUrlParams } from '../src/adsguard.js';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
}
const row = (day, ads) => ({ day, data: { ads } });
const ad = (landing, page) => ({ landing, page });

console.log('\nTHE 7 AUG BUG — the guard must build, and must carry its rules:');
const normal = [
  row('2026-08-07', [ad('https://www.glovbeauty.com/a', 'Glov'), ad('https://glovbeauty.com/b', 'Glov')]),
  row('2026-08-06', [ad('https://glovbeauty.com/a', 'Glov'), ad('https://glovbeauty.com/c', 'Glov Beauty')]),
];
const g1 = adsAbsenceGuard(adsCaptureFacts(normal, 50));
check('guard is non-empty for a normal capture', g1.length > 0);
check('guard states CAPTURE HEALTH', g1.includes('CAPTURE HEALTH'));
check('guard states the ABSENCE RULE', g1.includes('ABSENCE RULE'));
check('guard lists entities ALREADY SEEN BEFORE TODAY',
  g1.includes('ALREADY SEEN BEFORE TODAY') && g1.includes('glovbeauty.com') && g1.includes('Glov Beauty'));

console.log('\nBONAFIDE (4 Aug) — empty history proves nothing:');
const bonafide = [
  row('2026-08-04', [ad('https://bonafide.us/x', 'BonaFide'), ad('https://bonafide.us/y', 'BonaFide')]),
  row('2026-08-03', []),
  row('2026-08-02', []),
];
const cfB = adsCaptureFacts(bonafide, 50);
check('earlier empty captures → earlierHadAds false (nothing may be called new)', cfB.earlierHadAds === false);
check('guard says NO EARLIER ADS CAPTURED', adsAbsenceGuard(cfB).includes('NO EARLIER ADS CAPTURED'));
check('empty days contribute nothing to the known list', cfB.knownEntities.length === 0);

console.log('\nCASA AND BEYOND (4 Aug) — a thin slice may not judge switches or absence:');
const casa = [
  row('2026-08-04', [ad('https://casaandbeyond.com.au/a', 'Casa & Beyond'), ad('https://casaandbeyond.com.au/b', 'Casa & Beyond')]),
  row('2026-08-03', [ad('https://casaandbeyond.com.au/a', 'Casa & Beyond'), ad('https://casaandbeyond.com/b', 'Casa & Beyond'), ad('https://casaandbeyond.com/c', 'Casa & Beyond')]),
  row('2026-08-02', Array.from({ length: 28 }, (_, i) => ad('https://casaandbeyond.com/p' + i, 'Casa & Beyond'))),
  row('2026-08-01', Array.from({ length: 30 }, (_, i) => ad('https://casaandbeyond.com/p' + i, 'Casa & Beyond'))),
];
const cfC = adsCaptureFacts(casa, 50);
check('typical volume is the MEDIAN of recent captures, not yesterday', cfC.typical === 28, 'got ' + cfC.typical);
check('a fraction of typical is not a reliable sample', cfC.sampleReliable === false);
check('absence may not be judged from it', cfC.canJudgeAbsence === false);
check('guard carries the SAMPLE WARNING', adsAbsenceGuard(cfC).includes('SAMPLE WARNING'));
check('both destination domains are known from earlier days (a "switch" cannot be new)',
  cfC.knownEntities.includes('casaandbeyond.com') && cfC.knownEntities.includes('casaandbeyond.com.au'));

console.log('\nGLOV (1–2 Aug) — a capped capture is a rolling window, not the library:');
const capped = [
  row('2026-08-02', Array.from({ length: 48 }, (_, i) => ad('https://glovbeauty.com/p' + i, 'Glov'))),
  row('2026-08-01', Array.from({ length: 50 }, (_, i) => ad('https://glovbeauty.com/p' + i, i < 9 ? 'Persona ' + i : 'Glov'))),
];
const cfG = adsCaptureFacts(capped, 50);
check('48 of cap-50 counts as AT THE CAP', cfG.capped === true);
check('a capped capture may not judge absence', cfG.canJudgeAbsence === false);
const gG = adsAbsenceGuard(cfG);
check('guard names the collection cap', gG.includes('AT THE COLLECTION CAP'));
check('guard lists pages present before but absent today (as not-seen, never retired)',
  gG.includes('Pages present before but absent today') && gG.includes('Persona 0'));

console.log('\nHEALTHY CAPTURE — absence judgment allowed, rule still stated:');
const healthy = [
  row('2026-08-07', Array.from({ length: 20 }, (_, i) => ad('https://theoodie.com/p' + i, 'The Oodie'))),
  row('2026-08-06', Array.from({ length: 22 }, (_, i) => ad('https://theoodie.com/p' + i, 'The Oodie'))),
];
const cfH = adsCaptureFacts(healthy, 50);
check('full healthy capture may judge absence', cfH.canJudgeAbsence === true);
check('guard still states the ABSENCE RULE on a healthy day', adsAbsenceGuard(cfH).includes('ABSENCE RULE'));
check('no ads today → no guard (nothing to describe)', adsAbsenceGuard(adsCaptureFacts([row('2026-08-07', [])], 50)) === '');

console.log('\nAD-TOTAL BACKSTOP — counts of an incomplete sample never ship:');
check('"10 of 19 ads" softened', stripAdTotals('Testing hooks in 10 of 19 ads.') === 'Testing hooks in many of their ads.');
check('"19 active ads" softened', stripAdTotals('They run 19 active ads on Meta.') === 'They run their ads on Meta.');
check('deltas the founder allows stay intact', stripAdTotals('3 new ads launched this week.') === '3 new ads launched this week.');

console.log('\nURL-PARAM BACKSTOP — anything after "?" is tracking noise (founder, 10 Aug):');
check('Seranova UTM tail cut at the "?"',
  stripUrlParams('lands on https://quiz.seranova.com/misw-offer?tw_source=a&lptoken=1738 instead.')
  === 'lands on https://quiz.seranova.com/misw-offer instead.');
check('bare-domain URL with params cleaned',
  stripUrlParams('runs to try-derm.com/offer?utm_campaign=x today') === 'runs to try-derm.com/offer today');
check('genuine question mark after a domain survives',
  stripUrlParams('Are they still on seranova.com? Yes.') === 'Are they still on seranova.com? Yes.');
check('prose questions untouched', stripUrlParams('What changed? Nothing.') === 'What changed? Nothing.');

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
