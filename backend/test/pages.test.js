// TRACKED WHITELISTING PAGES — what a client can paste and what it must become.
//
// Founder, 9 Sep 2026: "add option to add more FB pages to track (for whitelisting pages)".
// The dangerous failures: a pasted POST/photo link stored as a page (the Pannonian Padel
// 'p' handle bug, in a new coat), an Ad Library SEARCH link mistaken for a page, and a
// page id silently becoming the brand's OWN page. The parser is pinned here; the
// never-own rule lives in ownPageIdsFor (tracked ids are filtered out of the own set).
import { parsePageRef } from '../src/ads.js';

let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + '\n      got: ' + JSON.stringify(got) + ' | wanted: ' + JSON.stringify(want)); }
}

console.log('\nparsePageRef — every form a client might paste:');
eq('bare numeric id', parsePageRef('183065794653'), { id: '183065794653' });
eq('Ad Library page link carries the id', parsePageRef('https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&view_all_page_id=184711951390377&search_type=page'), { id: '184711951390377' });
eq('profile.php?id=', parsePageRef('https://www.facebook.com/profile.php?id=100067470427617'), { id: '100067470427617' });
eq('modern /p/Name-id/ form', parsePageRef('https://www.facebook.com/p/Seranova-61553986792526/'), { id: '61553986792526' });
eq('vanity page URL → handle (resolved to an id on save)', parsePageRef('https://www.facebook.com/theofficialoodie'), { handle: 'theofficialoodie' });
eq('vanity URL with trailing path/query', parsePageRef('facebook.com/theofficialoodie/?ref=page_internal'), { handle: 'theofficialoodie' });
eq('@handle', parsePageRef('@drannie.md'), { handle: 'drannie.md' });
eq('bare handle', parsePageRef('DailyDiscountsOnline'), { handle: 'DailyDiscountsOnline' });

console.log('\nparsePageRef — things that are NOT a page:');
eq('a post link is not a page', parsePageRef('https://www.facebook.com/theofficialoodie/posts/pfbid02abc'), { handle: 'theofficialoodie' });
eq('a bare /posts/ path is rejected', parsePageRef('https://www.facebook.com/posts/123'), null);
eq('a reel link is rejected', parsePageRef('https://www.facebook.com/reel/1234567890'), null);
eq('a watch link is rejected', parsePageRef('https://www.facebook.com/watch/?v=1234567890'), null);
eq('an Ad Library SEARCH (no page id) is rejected', parsePageRef('https://www.facebook.com/ads/library/?q=oodie&country=ALL'), null);
eq('an Instagram link is not a Facebook page', parsePageRef('https://instagram.com/the_oodie'), null);
eq('a short id is not an id', parsePageRef('12345'), null);
eq('empty is null', parsePageRef(''), null);
eq('junk is null', parsePageRef('not a page at all!!'), null);

console.log('\n' + (fail ? '✗ ' + fail + ' FAILED, ' : '✓ ') + pass + ' passed\n');
process.exit(fail ? 1 : 0);
