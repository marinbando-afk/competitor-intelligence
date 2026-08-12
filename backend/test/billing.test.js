// BILLING GUARDS — the rules that stand between a customer and a second charge.
//
// Founder, 12 Aug 2026: signed up with a new account, paid, and the payment popup came
// straight back — so he paid a SECOND time. Cause: Stripe's browser redirect beats its
// webhook, so /api/billing/status still read plan_status = NULL, returned 'locked', and the
// app re-opened the paywall on an account that had just paid.
//
// Two rules now prevent it, and both are pinned here because the failure costs real money
// and is invisible in testing (test-mode webhooks are fast; live traffic is not).
import { isLiveSubStatus, mayOpenCheckout, LIVE_STATUSES } from '../src/billing.js';

let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + '\n      got: ' + JSON.stringify(got) + ' | wanted: ' + JSON.stringify(want)); }
}

console.log('\nA subscription the customer is already on the hook for blocks a new checkout:');
eq('active is live', isLiveSubStatus('active'), true);
eq('trialing is live — a card trial is still a subscription', isLiveSubStatus('trialing'), true);
eq('past_due is live — Stripe is still retrying the card', isLiveSubStatus('past_due'), true);
eq('unpaid is live — the subscription still exists', isLiveSubStatus('unpaid'), true);
eq('canceled is NOT live', isLiveSubStatus('canceled'), false);
eq('incomplete_expired is NOT live', isLiveSubStatus('incomplete_expired'), false);
eq('empty is NOT live', isLiveSubStatus(''), false);
eq('null is NOT live', isLiveSubStatus(null), false);
eq('the live set is exactly these four', LIVE_STATUSES, ['active', 'trialing', 'past_due', 'unpaid']);

console.log('\nmayOpenCheckout — the decision that caused the double charge:');
eq('genuinely unpaid, nothing in flight → checkout allowed',
  mayOpenCheckout({ liveSub: null, paymentInFlight: false }), true);

// THE BUG, exactly: the payment succeeded but our row hadn't caught up. Stripe knows about
// the subscription, so the answer must be no — regardless of what our database says.
eq('subscription exists in Stripe → BLOCKED even though plan_status was still NULL',
  mayOpenCheckout({ liveSub: { id: 'sub_1', status: 'trialing' }, paymentInFlight: false }), false);

// The client-side half: between the redirect back and the confirm landing, a payment IS in
// flight. The paywall must stay shut for that window or it invites the second purchase.
eq('payment in flight → BLOCKED (this is the ?billing=success window)',
  mayOpenCheckout({ liveSub: null, paymentInFlight: true }), false);
eq('both → BLOCKED', mayOpenCheckout({ liveSub: { id: 'sub_1' }, paymentInFlight: true }), false);

console.log('\n' + (fail ? '✗ ' + fail + ' FAILED, ' : '✓ ') + pass + ' passed\n');
process.exit(fail ? 1 : 0);
