// Payments (functions/billing.js) with a fake Stripe and an in-memory Firestore; plan effects via core.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const load = async () => ({
  billing: await import(path.join(ROOT, 'functions', 'billing.js')),
  core: await import(path.join(ROOT, 'functions', 'core.js')),
});

function fakeDb() {
  const docs = new Map();
  const copy = (v) => (v == null ? null : structuredClone(v));
  return {
    docs,
    get: async (p) => copy(docs.get(p)),
    set: async (p, v) => { docs.set(p, copy(v)); },
    txn: async (fn) => {
      const writes = new Map();
      const r = await fn({ get: async (p) => copy(docs.get(p)), set: (p, v) => writes.set(p, copy(v)) });
      for (const [p, v] of writes) docs.set(p, v);
      return r;
    },
  };
}

function fakeStripe() {
  const calls = { sessions: [], portals: [] };
  const prices = [
    { id: 'price_pass', lookup_key: 'kaimono_pass', unit_amount: 1990, currency: 'myr' },
    { id: 'price_month', lookup_key: 'kaimono_monthly', unit_amount: 2990, currency: 'myr' },
  ];
  return {
    calls,
    prices: { list: async ({ lookup_keys: keys }) => ({ data: prices.filter((p) => keys.includes(p.lookup_key)) }) },
    checkout: { sessions: { create: async (s) => { calls.sessions.push(s); return { url: 'https://checkout.stripe.com/c/pay/cs_test_1' }; } } },
    billingPortal: { sessions: { create: async (s) => { calls.portals.push(s); return { url: 'https://billing.stripe.com/p/session/1' }; } } },
    subscriptions: { retrieve: async (id) => ({ id, status: 'active', customer: 'cus_1', items: { data: [{ current_period_end: 1795000000 }] }, metadata: { uid: 'u1' } }) },
  };
}

const LIMITS = { free: 10, pro: 100, pass: 60, freeAsks: 40, proAsks: 1000 };
const NOW = Date.UTC(2026, 9, 30, 4);
const DAY = 86400000;

async function setup() {
  const { billing, core } = await load();
  const db = fakeDb();
  const stripe = fakeStripe();
  const deps = { stripe, db, appUrl: 'https://spidyloke.github.io/shopping/', passDays: 14, limits: LIMITS, now: NOW };
  const event = (id, type, object) => billing.handleEvent({ id, type, data: { object } }, deps);
  return { billing, core, db, stripe, deps, event };
}

test('plans come from Stripe prices by lookup key', async () => {
  const { billing, deps } = await setup();
  const r = await billing.listPlans(deps);
  assert.deepEqual(r.plans, [
    { id: 'pass', amount: 19.9, currency: 'MYR', days: 14, scans: 60 },
    { id: 'monthly', amount: 29.9, currency: 'MYR', scans: 100 },
  ]);
  assert.equal(r.free, 10);
});

test('checkout needs a real account, and carries the account to Stripe', async () => {
  const { billing, deps, stripe } = await setup();
  await assert.rejects(billing.createCheckout({ plan: 'pass' }, { uid: 'u1', anonymous: true }, deps), (e) => e.code === 'failed-precondition');
  const r = await billing.createCheckout({ plan: 'pass' }, { uid: 'u1', email: 'a@b.my' }, deps);
  assert.match(r.url, /checkout\.stripe\.com/);
  const s = stripe.calls.sessions[0];
  assert.equal(s.mode, 'payment');
  assert.equal(s.client_reference_id, 'u1');
  assert.equal(s.customer_email, 'a@b.my');
  assert.deepEqual(s.line_items, [{ price: 'price_pass', quantity: 1 }]);
  assert.equal(s.success_url, 'https://spidyloke.github.io/shopping/#/upgraded');
  await billing.createCheckout({ plan: 'monthly' }, { uid: 'u1', email: 'a@b.my' }, deps);
  assert.equal(stripe.calls.sessions[1].mode, 'subscription');
  assert.deepEqual(stripe.calls.sessions[1].subscription_data, { metadata: { uid: 'u1' } });
  await assert.rejects(billing.createCheckout({ plan: 'lifetime' }, { uid: 'u1', email: 'a@b.my' }, deps), (e) => e.code === 'invalid-argument');
});

test('no Stripe key yet: payment calls say payments are not set up', async () => {
  const { billing, deps } = await setup();
  await assert.rejects(billing.listPlans({ ...deps, stripe: null }), /aren't set up yet/);
});

test('a paid pass gives 60 scans for 14 days, once per event, then runs out', async () => {
  const { core, db, event } = await setup();
  const session = { mode: 'payment', payment_status: 'paid', client_reference_id: 'u1', customer: 'cus_1' };
  assert.equal(await event('evt_1', 'checkout.session.completed', session), 'pass');
  assert.equal(await event('evt_1', 'checkout.session.completed', session), 'already handled');
  const user = db.docs.get('users/u1');
  assert.equal(user.passUntil, NOW + 14 * DAY);
  assert.equal(user.stripeCustomer, 'cus_1');
  const u = await core.usageFor('u1', { db, now: NOW + DAY, limits: LIMITS });
  assert.deepEqual({ plan: u.plan, used: u.used, limit: u.limit, asks: u.asks.limit }, { plan: 'pass', used: 0, limit: 60, asks: 1000 });
  assert.equal((await core.usageFor('u1', { db, now: NOW + 15 * DAY, limits: LIMITS })).plan, 'free');
});

test('FPX and other delayed payments only count once they settle', async () => {
  const { db, event } = await setup();
  const session = { mode: 'payment', payment_status: 'unpaid', client_reference_id: 'u1' };
  assert.equal(await event('evt_a', 'checkout.session.completed', session), 'waiting for payment');
  assert.equal(db.docs.has('users/u1'), false);
  assert.equal(await event('evt_b', 'checkout.session.async_payment_succeeded', { ...session, payment_status: 'paid' }), 'pass');
  assert.ok(db.docs.get('users/u1').passUntil > NOW);
});

test('a second pass while one runs extends it and resets the count', async () => {
  const { db, event } = await setup();
  const paid = { mode: 'payment', payment_status: 'paid', client_reference_id: 'u1' };
  await event('e1', 'checkout.session.completed', paid);
  db.docs.get('users/u1').passUsed = 55;
  await event('e2', 'checkout.session.completed', paid);
  assert.equal(db.docs.get('users/u1').passUntil, NOW + 28 * DAY);
  assert.equal(db.docs.get('users/u1').passUsed, 0);
});

test('the monthly plan follows the subscription: on, renewed, cancelled', async () => {
  const { core, db, event, stripe, billing, deps } = await setup();
  await event('s1', 'checkout.session.completed', { mode: 'subscription', payment_status: 'paid', client_reference_id: 'u1', subscription: 'sub_1' });
  let user = db.docs.get('users/u1');
  assert.equal(user.plan, 'pro');
  assert.equal(user.proUntil, 1795000000 * 1000 + DAY);
  assert.equal((await core.usageFor('u1', { db, now: NOW, limits: LIMITS })).limit, 100);
  await event('s2', 'customer.subscription.deleted', { id: 'sub_1', status: 'canceled', customer: 'cus_1', metadata: { uid: 'u1' }, current_period_end: 1795000000 });
  user = db.docs.get('users/u1');
  assert.equal(user.plan, 'free');
  assert.equal((await core.usageFor('u1', { db, now: NOW + 1000, limits: LIMITS })).plan, 'free');
  // Manage subscription opens Stripe's portal for the customer
  const r = await billing.createPortal({ uid: 'u1' }, deps);
  assert.match(r.url, /billing\.stripe\.com/);
  assert.equal(stripe.calls.portals[0].customer, 'cus_1');
});

test('scans on a pass count against the pass, not the month', async () => {
  const { core, db, event } = await setup();
  await event('p', 'checkout.session.completed', { mode: 'payment', payment_status: 'paid', client_reference_id: 'u1' });
  const prompts = await import(path.join(ROOT, 'prompt.js'));
  const fetch = async (url) => ({ ok: true, status: 200, json: async () => (url.includes('vision')
    ? { responses: [{ fullTextAnnotation: { text: '¥3,000' } }] }
    : { candidates: [{ content: { parts: [{ text: '```json\n{"product_name":"x"}\n```' }] } }] }) });
  const deps = { db, fetch, prompts, keys: {}, model: 'm', clock: () => NOW + DAY, limits: { ...LIMITS, daily: 100, perIp: 40, dailyAsks: 100 } };
  const out = await core.runScan({ images: ['A'.repeat(200)] }, { uid: 'u1', deps });
  assert.deepEqual({ plan: out.usage.plan, used: out.usage.used, limit: out.usage.limit }, { plan: 'pass', used: 1, limit: 60 });
  assert.equal(db.docs.get('users/u1').used, undefined);
});

test('webhook signatures: the Stripe library accepts a signed event and refuses a forged one', () => {
  const Stripe = require(path.join(ROOT, 'functions', 'node_modules', 'stripe'));
  const stripe = new Stripe('sk_test_x');
  const payload = JSON.stringify({ id: 'evt_sig', type: 'checkout.session.completed', data: { object: {} } });
  const secret = 'whsec_test';
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret });
  assert.equal(stripe.webhooks.constructEvent(Buffer.from(payload), header, secret).id, 'evt_sig');
  assert.throws(() => stripe.webhooks.constructEvent(Buffer.from(payload), header, 'whsec_other'));
});
