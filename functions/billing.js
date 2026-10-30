// Payments with Stripe: a trip pass (one payment) and a monthly subscription.
//
// Pure logic like core.js: index.js passes in a Stripe client, Firestore and the settings. Prices
// live in Stripe under lookup keys (kaimono_pass, kaimono_monthly), so changing a price needs no
// code change. What a payment unlocks is written to users/{uid}:
//   pass     passUntil (now + PASS_DAYS, or extended if one is running) and passUsed reset to 0
//   monthly  plan "pro", proUntil (end of the paid period, plus a day's grace), Stripe IDs
// Each Stripe event is handled once (events/{id}), since Stripe can send one more than once.

import { ScanError } from './core.js';

const DAY = 24 * 60 * 60 * 1000;
export const LOOKUP = { pass: 'kaimono_pass', monthly: 'kaimono_monthly' };

function ready(stripe) {
  if (!stripe) throw new ScanError('failed-precondition', 'Payments aren\'t set up yet.');
}

// The plans and their prices, for the upgrade sheet.
export async function listPlans({ stripe, limits, passDays }) {
  ready(stripe);
  const { data } = await stripe.prices.list({ lookup_keys: Object.values(LOOKUP), active: true });
  const price = (key) => data.find((p) => p.lookup_key === key);
  const out = [];
  if (price(LOOKUP.pass)) out.push({ id: 'pass', amount: price(LOOKUP.pass).unit_amount / 100, currency: price(LOOKUP.pass).currency.toUpperCase(), days: passDays, scans: limits.pass });
  if (price(LOOKUP.monthly)) out.push({ id: 'monthly', amount: price(LOOKUP.monthly).unit_amount / 100, currency: price(LOOKUP.monthly).currency.toUpperCase(), scans: limits.pro });
  return { plans: out, free: limits.free };
}

// A Stripe Checkout page for a signed-in (not anonymous) account; the app opens its URL.
export async function createCheckout({ plan }, { uid, email, anonymous }, { stripe, db, appUrl }) {
  ready(stripe);
  if (!LOOKUP[plan]) throw new ScanError('invalid-argument', 'Unknown plan.');
  if (anonymous || !email) throw new ScanError('failed-precondition', 'Create an account first, so what you buy isn\'t tied to this phone.');
  const { data } = await stripe.prices.list({ lookup_keys: [LOOKUP[plan]], active: true });
  if (!data[0]) throw new ScanError('failed-precondition', 'That plan isn\'t on sale yet.');
  const user = (await db.get(`users/${uid}`)) || {};
  const monthly = plan === 'monthly';
  if (monthly && user.plan === 'pro' && user.proUntil > Date.now()) throw new ScanError('already-exists', 'You already have the monthly plan. Manage it from Settings.');
  const session = await stripe.checkout.sessions.create({
    mode: monthly ? 'subscription' : 'payment',
    line_items: [{ price: data[0].id, quantity: 1 }],
    client_reference_id: uid,
    metadata: { uid, plan },
    ...(user.stripeCustomer ? { customer: user.stripeCustomer } : { customer_email: email }),
    ...(monthly ? { subscription_data: { metadata: { uid } } } : { customer_creation: 'always' }),
    allow_promotion_codes: true,
    success_url: `${appUrl}#/upgraded`,
    cancel_url: `${appUrl}#/`,
  });
  return { url: session.url };
}

// Stripe's own page for changing card, cancelling or getting invoices.
export async function createPortal({ uid }, { stripe, db, appUrl }) {
  ready(stripe);
  const user = (await db.get(`users/${uid}`)) || {};
  if (!user.stripeCustomer) throw new ScanError('failed-precondition', 'No payments on this account yet.');
  const session = await stripe.billingPortal.sessions.create({ customer: user.stripeCustomer, return_url: appUrl });
  return { url: session.url };
}

const periodEnd = (sub) => sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end ?? null;
const ACTIVE = ['active', 'trialing', 'past_due'];

async function applyPass(db, uid, { now, passDays, customer }) {
  await db.txn(async (t) => {
    const user = (await t.get(`users/${uid}`)) || {};
    const from = user.passUntil > now ? user.passUntil : now;
    t.set(`users/${uid}`, { ...user, passUntil: from + passDays * DAY, passUsed: 0, passBoughtAt: now, ...(customer ? { stripeCustomer: customer } : {}), updatedAt: now });
  });
}

async function applySubscription(db, uid, sub, now) {
  await db.txn(async (t) => {
    const user = (await t.get(`users/${uid}`)) || {};
    const end = periodEnd(sub);
    const on = ACTIVE.includes(sub.status) && end;
    t.set(`users/${uid}`, {
      ...user,
      plan: on ? 'pro' : 'free',
      proUntil: on ? end * 1000 + DAY : Math.min(user.proUntil || now, now),
      stripeCustomer: sub.customer || user.stripeCustomer || null,
      stripeSubscription: sub.id,
      subscriptionStatus: sub.status,
      cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
      updatedAt: now,
    });
  });
}

export async function handleEvent(event, { stripe, db, now = Date.now(), passDays }) {
  if (await db.get(`events/${event.id}`)) return 'already handled';
  const obj = event.data.object;
  let what = 'ignored';
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const uid = obj.client_reference_id || obj.metadata?.uid;
      if (!uid) return 'no account on the session';
      if (obj.payment_status !== 'paid') { what = 'waiting for payment'; break; } // FPX and others settle later
      if (obj.mode === 'payment') {
        await applyPass(db, uid, { now, passDays, customer: obj.customer });
        what = 'pass';
      } else if (obj.mode === 'subscription' && obj.subscription) {
        const sub = typeof obj.subscription === 'string' ? await stripe.subscriptions.retrieve(obj.subscription) : obj.subscription;
        await applySubscription(db, uid, sub, now);
        what = 'subscription';
      }
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const uid = obj.metadata?.uid;
      if (!uid) return 'no account on the subscription';
      await applySubscription(db, uid, event.type.endsWith('deleted') ? { ...obj, status: 'canceled' } : obj, now);
      what = `subscription ${obj.status}`;
      break;
    }
    default:
  }
  await db.set(`events/${event.id}`, { type: event.type, at: now, what, expireAt: new Date(now + 30 * DAY) });
  return what;
}
