// Stripe billing — the standard offer: $197/mo (2 competitors included) + $47/mo per
// additional competitor. Trial (founder, 8 Aug): 30 days, CARD REQUIRED — the trial
// starts at Stripe Checkout ($0 today, converts automatically on day 30). Existing beta
// accounts are comped (users.comp) and admins never pay. Legacy card-free trials granted
// before this change keep working until they expire.
//
// DORMANT WITHOUT KEYS: every entry point checks billingEnabled() first, so the app runs
// exactly as before until these are set in Railway → Variables:
//   STRIPE_SECRET_KEY      (required)  sk_live_… or sk_test_…
//   STRIPE_WEBHOOK_SECRET  (required)  whsec_… — from the dashboard webhook endpoint
//                                      pointing at  POST /api/stripe/webhook
//   APP_URL                (optional)  defaults to https://watchback.ai
//   STRIPE_PRICE_BASE / STRIPE_PRICE_ADDON (optional) — price-id overrides; without them
//   the catalog below is created automatically, so NO dashboard product setup is needed.
//
// Prices are found-or-created by lookup_key (idempotent across boots and test/live modes):
//   wb_base_197  → $197.00/mo, quantity always 1
//   wb_addon_47  → $47.00/mo,  quantity = max(0, competitors - 2)

import { pool } from './db.js';
import { capiEvent } from './metacapi.js';

const BASE_CENTS = 19700, ADDON_CENTS = 4700, INCLUDED = 2, TRIAL_DAYS = Number(process.env.TRIAL_DAYS) || 30;
const APP_URL = (process.env.APP_URL || 'https://watchback.ai').replace(/\/+$/, '');

export function billingEnabled() { return !!process.env.STRIPE_SECRET_KEY; }

let _stripe = null;
async function stripe() {
  if (_stripe) return _stripe;
  const { default: Stripe } = await import('stripe');
  _stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
  return _stripe;
}

// ── catalog: find-or-create by lookup_key, cached per boot ────────────────────
let _prices = null;
async function prices() {
  if (_prices) return _prices;
  if (process.env.STRIPE_PRICE_BASE && process.env.STRIPE_PRICE_ADDON) {
    _prices = { base: process.env.STRIPE_PRICE_BASE, addon: process.env.STRIPE_PRICE_ADDON };
    return _prices;
  }
  const s = await stripe();
  const found = await s.prices.list({ lookup_keys: ['wb_base_197', 'wb_addon_47'], limit: 10 });
  let base = found.data.find((p) => p.lookup_key === 'wb_base_197');
  let addon = found.data.find((p) => p.lookup_key === 'wb_addon_47');
  if (!base || !addon) {
    const prod = await s.products.create({ name: 'WatchBack — Competitor Intelligence' });
    if (!base) base = await s.prices.create({ product: prod.id, lookup_key: 'wb_base_197', unit_amount: BASE_CENTS, currency: 'usd', recurring: { interval: 'month' }, nickname: 'Base — 2 competitors included' });
    if (!addon) addon = await s.prices.create({ product: prod.id, lookup_key: 'wb_addon_47', unit_amount: ADDON_CENTS, currency: 'usd', recurring: { interval: 'month' }, nickname: 'Additional competitor' });
  }
  _prices = { base: base.id, addon: addon.id };
  return _prices;
}

// ── per-user state ────────────────────────────────────────────────────────────
async function userRow(uid) {
  const r = await pool.query('SELECT id, email, admin, comp, stripe_customer_id, stripe_subscription_id, plan_status, trial_ends_at, period_end, created_at FROM users WHERE id = $1', [uid]);
  return r.rows[0] || null;
}
async function competitorCount(uid) {
  const r = await pool.query('SELECT COUNT(*)::int AS n FROM competitors WHERE user_id = $1', [uid]);
  return (r.rows[0] && r.rows[0].n) || 0;
}

// The single source of truth the app and the gates read.
// status: 'disabled' | 'comp' | 'active' | 'trialing' | 'past_due' | 'locked'
export async function billingStatus(uid) {
  if (!billingEnabled()) return { status: 'disabled', ok: true };
  const u = await userRow(uid);
  if (!u) return { status: 'locked', ok: false };
  if (u.admin || u.comp) return { status: 'comp', ok: true };
  const sub = String(u.plan_status || '');
  if (sub === 'active' || sub === 'trialing') {
    const n = await competitorCount(uid);
    return { status: 'active', ok: true, periodEnd: u.period_end, competitors: n, monthly: (BASE_CENTS + Math.max(0, n - INCLUDED) * ADDON_CENTS) / 100 };
  }
  // past_due keeps access while Stripe retries the card — the portal fixes it.
  if (sub === 'past_due') return { status: 'past_due', ok: true, periodEnd: u.period_end };
  if (u.trial_ends_at && new Date(u.trial_ends_at) > new Date()) {
    const days = Math.max(1, Math.ceil((new Date(u.trial_ends_at) - Date.now()) / 86400000));
    return { status: 'trialing', ok: true, trialDaysLeft: days, trialEndsAt: u.trial_ends_at };
  }
  // trialAvailable → the checkout will start a 30-day card trial for this account (fresh
  // signups); false → their trial is spent, checkout charges from day one. Drives the
  // upgrade modal's copy ("Start your 30-day trial" vs "Trial ended — subscribe").
  return { status: 'locked', ok: false, trialAvailable: !u.stripe_subscription_id && !(u.trial_ends_at && new Date(u.trial_ends_at) < new Date()), trialDays: TRIAL_DAYS };
}

// ── checkout / portal ─────────────────────────────────────────────────────────
async function ensureCustomer(u) {
  const s = await stripe();
  // A stored id can be stale: created under a LIVE key and now used with a TEST key (or
  // deleted in the dashboard). Stripe then fails every checkout with "No such customer",
  // permanently, so verify before reusing and fall through to creating a fresh one.
  if (u.stripe_customer_id) {
    try {
      const ex = await s.customers.retrieve(u.stripe_customer_id);
      if (ex && !ex.deleted) return u.stripe_customer_id;
    } catch (e) { /* missing in this mode → recreate below */ }
    await pool.query('UPDATE users SET stripe_customer_id = NULL, stripe_subscription_id = NULL, plan_status = NULL WHERE id = $1', [u.id]);
  }
  const c = await s.customers.create({ email: u.email, metadata: { wb_uid: String(u.id) } });
  await pool.query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [c.id, u.id]);
  return c.id;
}

// LIVE SUBSCRIPTIONS FOR A CUSTOMER, STRAIGHT FROM STRIPE.
// The DB is not usable as the duplicate guard here — being stale is exactly the failure
// mode we are guarding against (see the double-charge note on checkoutSession).
// A subscription in ANY of these states is one the customer is on the hook for, so a second
// checkout would be a second charge. 'unpaid' and 'past_due' count: the subscription still
// exists and Stripe is still retrying it. Exported so the rule is pinned by a test rather
// than re-derived at each call site. (founder double-charge, 12 Aug)
export const LIVE_STATUSES = ['active', 'trialing', 'past_due', 'unpaid'];
export function isLiveSubStatus(st) { return LIVE_STATUSES.includes(String(st || '')); }
// The one decision that decides whether a payment screen may be shown at all.
export function mayOpenCheckout({ liveSub, paymentInFlight }) { return !liveSub && !paymentInFlight; }
async function liveSubscriptionFor(custId) {
  if (!custId) return null;
  try {
    const s = await stripe();
    const subs = await s.subscriptions.list({ customer: custId, status: 'all', limit: 10 });
    return (subs.data || []).find((x) => LIVE_STATUSES.includes(x.status)) || null;
  } catch (e) { return null; }   // Stripe unreachable → fall through to normal checkout
}

// Same question, asked by EMAIL. ensureCustomer mints a fresh customer whenever the stored
// id can't be retrieved (mode switch, deleted in the dashboard) — which would hide an
// existing subscription from the guard above and let a second one be created under the new
// customer. Checking every Stripe customer on this email closes that door.
async function liveSubscriptionByEmail(email) {
  if (!email) return null;
  try {
    const s = await stripe();
    const cs = await s.customers.list({ email: String(email), limit: 10 });
    for (const c of (cs.data || [])) {
      const sub = await liveSubscriptionFor(c.id);
      if (sub) return sub;
    }
  } catch (e) { /* fall through */ }
  return null;
}

// DOUBLE-CHARGE GUARD (founder, 12 Aug: signed up, paid, the payment popup came straight
// back, paid a SECOND time). The cause was a race — Stripe redirects the browser back
// faster than it delivers the webhook, so plan_status was still NULL, billingStatus said
// 'locked' and the app re-opened the paywall on an account that had just paid. The client
// fix removes the race; THIS is the guard that makes a second charge impossible even if a
// user reaches checkout again by any route (stale tab, back button, bookmarked link):
// ask Stripe — not our database — whether this customer already has a live subscription,
// and if so adopt it and refuse to open a second checkout.
export async function checkoutSession(uid) {
  const u = await userRow(uid);
  if (!u) { const e = new Error('No such account.'); e.status = 404; throw e; }
  const s = await stripe(), pr = await prices();
  const cust = await ensureCustomer(u);
  const existing = (await liveSubscriptionFor(cust)) || (await liveSubscriptionByEmail(u.email));
  if (existing) {
    await applySubscription(existing, u.id);   // heal the row the race left behind
    const e = new Error('You are already subscribed — no second payment is needed. Manage your plan under 💳 Billing.');
    e.status = 409; e.code = 'already_subscribed';
    throw e;
  }
  const extra = Math.max(0, (await competitorCount(uid)) - INCLUDED);
  const items = [{ price: pr.base, quantity: 1 }];
  if (extra > 0) items.push({ price: pr.addon, quantity: extra });
  // 30-day trial WITH card, but only for a genuinely fresh account: anyone whose legacy
  // card-free trial already EXPIRED, or who held a subscription before, pays from day one
  // — otherwise "cancel, re-checkout" would mint a fresh free month forever.
  const freshTrial = !u.stripe_subscription_id && !(u.trial_ends_at && new Date(u.trial_ends_at) < new Date());
  const sess = await s.checkout.sessions.create({
    mode: 'subscription',
    customer: cust,
    line_items: items,
    allow_promotion_codes: true,
    payment_method_collection: 'always',   // the card is the point — collect it even during the $0 trial
    subscription_data: Object.assign({ metadata: { wb_uid: String(u.id) } }, freshTrial ? { trial_period_days: TRIAL_DAYS } : {}),
    success_url: APP_URL + '/app.html?billing=success&sid={CHECKOUT_SESSION_ID}',
    cancel_url: APP_URL + '/app.html?billing=cancelled',
  });
  return { url: sess.url };
}

// RECONCILE ON RETURN — the fix for the race itself.
// Stripe's browser redirect regularly beats its webhook, so the app used to come back from
// a successful payment, read a plan_status the webhook had not written yet, and conclude
// the account was unpaid. Instead of waiting and hoping, the return path now ASKS Stripe
// about the session it was just given and writes the answer itself. The webhook still
// arrives and applies the same state — both paths are idempotent, so whichever wins is
// fine. Verifies the session belongs to this account before applying anything.
export async function confirmCheckout(uid, sessionId) {
  if (!billingEnabled()) return billingStatus(uid);
  const u = await userRow(uid);
  if (!u) { const e = new Error('No such account.'); e.status = 404; throw e; }
  const sid = String(sessionId || '').trim();
  if (/^cs_[A-Za-z0-9_]+$/.test(sid)) {
    try {
      const s = await stripe();
      const sess = await s.checkout.sessions.retrieve(sid);
      const owns = sess && sess.customer && u.stripe_customer_id && String(sess.customer) === String(u.stripe_customer_id);
      if (owns && sess.subscription) {
        const sub = await s.subscriptions.retrieve(String(sess.subscription));
        await applySubscription(sub, u.id);
      }
    } catch (e) { /* fall through to the sweep below, then to plain status */ }
  }
  // No usable session id (or it failed): sweep for any live subscription on this customer.
  // This is what rescues an account whose webhook never arrived at all.
  const fresh = await userRow(uid);
  if (!fresh.plan_status || !['active', 'trialing', 'past_due'].includes(String(fresh.plan_status))) {
    const live = (await liveSubscriptionFor(fresh.stripe_customer_id)) || (await liveSubscriptionByEmail(fresh.email));
    if (live) await applySubscription(live, fresh.id);
  }
  return billingStatus(uid);
}

// ADMIN DIAGNOSTIC — every subscription Stripe holds for an account, so a duplicate is
// visible without hunting through the dashboard. Read-only on purpose: cancelling and
// refunding move real money and stay a human decision in Stripe's own UI.
export async function subscriptionAudit(uid) {
  if (!billingEnabled()) return { enabled: false };
  const u = await userRow(uid);
  if (!u) { const e = new Error('No such account.'); e.status = 404; throw e; }
  const s = await stripe();
  const seen = new Map();
  const custIds = new Set([u.stripe_customer_id].filter(Boolean));
  try {
    const cs = await s.customers.list({ email: u.email, limit: 10 });
    (cs.data || []).forEach((c) => custIds.add(c.id));
  } catch (e) { /* stored id only */ }
  for (const cid of custIds) {
    try {
      const subs = await s.subscriptions.list({ customer: cid, status: 'all', limit: 20 });
      for (const x of (subs.data || [])) {
        seen.set(x.id, {
          id: x.id, customer: cid, status: x.status,
          created: x.created ? new Date(x.created * 1000).toISOString().slice(0, 10) : null,
          monthly: (x.items.data || []).reduce((t, i) => t + ((i.price && i.price.unit_amount) || 0) * (i.quantity || 1), 0) / 100,
        });
      }
    } catch (e) { /* skip this customer */ }
  }
  const all = [...seen.values()];
  const live = all.filter((x) => LIVE_STATUSES.includes(x.status));
  return {
    enabled: true, email: u.email, customers: [...custIds], stored: u.stripe_customer_id,
    planStatus: u.plan_status, subscriptions: all, liveCount: live.length,
    duplicate: live.length > 1,
    monthlyTotal: live.reduce((t, x) => t + x.monthly, 0),
  };
}

export async function portalSession(uid) {
  const u = await userRow(uid);
  if (!u || !u.stripe_customer_id) { const e = new Error('No billing account yet — subscribe first.'); e.status = 400; throw e; }
  const s = await stripe();
  const p = await s.billingPortal.sessions.create({ customer: u.stripe_customer_id, return_url: APP_URL + '/app.html' });
  return { url: p.url };
}

// ── keep the addon quantity in sync with the competitor count ─────────────────
// Called best-effort after any competitor add/remove for a user; Stripe prorates.
export async function syncQuantity(uid) {
  try {
    if (!billingEnabled()) return;
    const u = await userRow(uid);
    if (!u || !u.stripe_subscription_id || u.admin || u.comp) return;
    if (u.plan_status !== 'active' && u.plan_status !== 'trialing' && u.plan_status !== 'past_due') return;
    const s = await stripe(), pr = await prices();
    const extra = Math.max(0, (await competitorCount(uid)) - INCLUDED);
    const sub = await s.subscriptions.retrieve(u.stripe_subscription_id);
    const item = (sub.items.data || []).find((i) => i.price && i.price.id === pr.addon);
    if (item && extra === 0) await s.subscriptionItems.del(item.id, { proration_behavior: 'create_prorations' });
    else if (item && item.quantity !== extra) await s.subscriptionItems.update(item.id, { quantity: extra, proration_behavior: 'create_prorations' });
    else if (!item && extra > 0) await s.subscriptionItems.create({ subscription: sub.id, price: pr.addon, quantity: extra, proration_behavior: 'create_prorations' });
  } catch (e) { console.warn('billing syncQuantity:', e.message); }   // never block the product on billing
}

// ── webhook ───────────────────────────────────────────────────────────────────
// `fallbackUid` is used when we already know whose subscription this is (the checkout
// return path, the duplicate guard) — a subscription created outside our checkout can
// carry no wb_uid metadata, and matching on customer id alone would leave it unlinked.
async function applySubscription(sub, fallbackUid) {
  const uid = Number(sub.metadata && sub.metadata.wb_uid) || Number(fallbackUid) || null;
  const periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000) : null;
  if (uid) {
    await pool.query('UPDATE users SET stripe_subscription_id = $1, plan_status = $2, period_end = $3 WHERE id = $4', [sub.id, sub.status, periodEnd, uid]);
  } else if (sub.customer) {
    await pool.query('UPDATE users SET stripe_subscription_id = $1, plan_status = $2, period_end = $3 WHERE stripe_customer_id = $4', [sub.id, sub.status, periodEnd, String(sub.customer)]);
  }
}

export async function handleWebhook(rawBody, signature) {
  const s = await stripe();
  const ev = s.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
  switch (ev.type) {
    case 'checkout.session.completed': {
      const sess = ev.data.object;
      if (sess.mode === 'subscription' && sess.subscription) {
        const sub = await s.subscriptions.retrieve(String(sess.subscription));
        await applySubscription(sub);
        // Server-side Meta events on the ground truth (money moved) — event_id is the
        // checkout-session id, shared with the browser pixel for deduplication. Fire and
        // forget: an ads-tracking hiccup must never fail the webhook.
        try {
          const monthly = (sub.items.data || []).reduce((t, i) => t + (i.price && i.price.unit_amount || 0) * (i.quantity || 1), 0) / 100;
          const email = (sess.customer_details && sess.customer_details.email) || '';
          capiEvent({ name: 'Purchase', value: monthly, currency: 'usd', email, eventId: sess.id }).catch(() => {});
          capiEvent({ name: 'Subscribe', value: monthly, currency: 'usd', email, eventId: sess.id + '-sub' }).catch(() => {});
          // The card-required trial STARTS here, not at signup (free-account funnel, 12 Aug).
          capiEvent({ name: 'StartTrial', value: 0, currency: 'usd', email, eventId: sess.id + '-trial' }).catch(() => {});
        } catch (e) { /* tracking only */ }
      }
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      await applySubscription(ev.data.object);
      break;
    case 'customer.subscription.deleted': {
      const sub = ev.data.object;
      await pool.query("UPDATE users SET plan_status = 'canceled' WHERE stripe_subscription_id = $1", [sub.id]);
      break;
    }
    default: break;   // signature-verified but not ours to handle
  }
  return { received: true, type: ev.type };
}

export { TRIAL_DAYS, INCLUDED };
