// PER-CLIENT CHANNEL ACCESS — the rules a restricted client's delivery depends on.
//
// The dangerous failure here is silent: a normalisation slip that turns "social only" into
// "everything" leaks ads/website/email to an account that doesn't pay for them, and nothing
// in the UI would look broken. The opposite slip — an empty list read as "nothing" — blanks
// a paying client's dashboard from one admin mis-click. Both are pinned below.
import { normChannels, allows, channelsLabel, ALL_CHANNELS } from '../src/channels.js';

let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + '\n      got: ' + JSON.stringify(got) + ' | wanted: ' + JSON.stringify(want)); }
}

console.log('\nnormChannels — NULL always means "the normal plan, all four":');
eq('null stays null', normChannels(null), null);
eq('undefined stays null', normChannels(undefined), null);
eq('empty array = unrestricted, never "nothing"', normChannels([]), null);
eq('all four = unrestricted', normChannels(['ads', 'social', 'website', 'email']), null);
eq('all four, any order = unrestricted', normChannels(['email', 'ads', 'website', 'social']), null);
eq('only junk = unrestricted', normChannels(['bogus', '']), null);

console.log('\nnormChannels — a real subset survives, in a stable order:');
eq('social only', normChannels(['social']), ['social']);
eq('order is canonical, not input order', normChannels(['email', 'ads']), ['ads', 'email']);
eq('duplicates collapse', normChannels(['social', 'social']), ['social']);
eq('case and whitespace tolerated', normChannels([' Social ', 'ADS']), ['ads', 'social']);
eq('unknown keys dropped, known kept', normChannels(['social', 'carrier-pigeon']), ['social']);
eq('comma string (a hand-typed value) parses', normChannels('social,email'), ['social', 'email']);

console.log('\nallows — the one question every delivery surface asks:');
eq('null allows ads', allows(null, 'ads'), true);
eq('null allows email', allows(null, 'email'), true);
eq('social-only allows social', allows(['social'], 'social'), true);
eq('social-only BLOCKS ads', allows(['social'], 'ads'), false);
eq('social-only BLOCKS website', allows(['social'], 'website'), false);
eq('social-only BLOCKS email', allows(['social'], 'email'), false);

console.log('\nlabels + catalogue:');
eq('unrestricted label', channelsLabel(null), 'All channels');
eq('restricted label', channelsLabel(['social']), 'Organic Social only');
eq('two-channel label', channelsLabel(['ads', 'social']), 'Ads + Organic Social only');
eq('catalogue is the four delivery channels', ALL_CHANNELS, ['ads', 'social', 'website', 'email']);

console.log('\n' + (fail ? '✗ ' + fail + ' FAILED, ' : '✓ ') + pass + ' passed\n');
process.exit(fail ? 1 : 0);
