// FINDINGS ENGINE FIXTURES — the engine decides what is true, so it needs its own tests.
// Each case is a real failure from this week, replayed as capture rows.
import { findingsBlock } from '../src/findings.js';

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } }

// findingsBlock must state the contract the whole design rests on.
const b = findingsBlock([{ type: 'state', text: 'Ads run to example.com.' }]);
console.log('\nFINDINGS CONTRACT:');
check('block names the findings as the ONLY material', /ONLY things established by the data/i.test(b));
check('block forbids adding claims', /may NOT add any\s*\n?claim/i.test(b));
check('block forbids invented newness verbs', /new, first, changed, dropped, launched or switched/i.test(b));
check('block tells the model to respect limits', /limit.*cannot establish/is.test(b));
check('empty findings produce no block', findingsBlock([]) === '' && findingsBlock(null) === '');

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
