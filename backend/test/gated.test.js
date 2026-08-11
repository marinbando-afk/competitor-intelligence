// FALLBACK QUALITY — when the claim gate strips a model read, what ships instead must be
// SUBSTANCE (founder, 11 Aug: "how do we prevent sending updates like you initially sent
// and make sure you send it the way you corrected yourself? for all the competitors").
// Nolan, 10 Aug: the whole ads read shipped as "All 100 ads in today's capture run to
// nolaninterior.com…" because the fallback took state findings in raw order and the
// domains/pages inventory lines came first. Run: node test/gated.test.js
import { gated } from '../src/insights.js';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
}

const FINDS = [
  { type: 'context', key: 'ads.volume', text: '100 ads captured on 2026-08-10 (typical for this brand: 90)' },
  { type: 'state', key: 'ads.domains', text: 'Every captured ad runs to nolaninterior.com.' },
  { type: 'state', key: 'ads.pages', text: 'The captured ads run from "Nolan Interior".' },
  { type: 'new', key: 'ads.launches', text: '6 new ads launched since 2026-08-08 (Meta start dates; 6 video, 0 image/carousel); newest opens: "🚨 BEST SELLER: Miracle Sofa Cover" → nolaninterior.com.', evidence: { hook: '🚨 BEST SELLER: Miracle Sofa Cover' } },
  { type: 'state', key: 'ads.staleOffer:bf', text: '"Black Friday" offer is running 8.3 months out of season.' },
];

console.log('\nFALLBACK RANKING:');
const fb = gated({ text: '' }, FINDS);
check('model text stripped → launches LEAD the fallback', fb.startsWith('6 new ads launched'));
check('stale offer ships in the fallback', fb.includes('out of season'));
check('domains/pages inventory boilerplate never leads', !fb.startsWith('Every captured ad') && !fb.startsWith('The captured ads'));
check('context findings (capture arithmetic) never ship', !fb.includes('typical for this brand'));
check('surviving model text passes through untouched', gated({ text: 'Kept read.' }, FINDS) === 'Kept read.');

// Only inventory lines exist → they still ship (better than an empty read).
const inv = gated({ text: '' }, FINDS.filter((f) => f.key === 'ads.domains' || f.key === 'ads.pages'));
check('inventory-only day still produces a read', inv.includes('Every captured ad runs to nolaninterior.com.'));

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
