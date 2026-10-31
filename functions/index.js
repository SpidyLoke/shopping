// Kaimono backend on Firebase: callable functions the app uses to scan without its own API keys.
// The logic is in core.js; this file connects it to Firestore, the secrets and the settings below.
//
// Settings (functions/.env, or asked for on first deploy):
//   FREE_SCANS    scans a month on the free plan (default 10)
//   PRO_SCANS     scans a month on the monthly plan (default 100)
//   DAILY_SCANS   most scans the whole app runs in a day, so a bug or abuse can't run up the bill (default 500)
//   PER_IP_SCANS  most scans from one connection in a day (default 40)
//   FREE_ASKS, PRO_ASKS, DAILY_ASKS  the same for questions (Worth it, Ask, shelf, Compare): 40, 1000, 2000
//   GEMINI_MODEL  (default gemini-flash-latest); GEMINI_FALLBACK_MODEL when it's overloaded (gemini-flash-lite-latest)
//   CACHE_DAYS    how long a barcode's market prices are reused (default 7)
//   PASS_SCANS, PASS_DAYS  what a trip pass gives (default 60 scans over 14 days)
//   APP_URL       where Stripe sends people back to (default https://spidyloke.github.io/shopping/)
//   OWNER_UIDS    account IDs (Settings shows yours) that may open the beta dashboard, comma-separated
// Secrets (firebase functions:secrets:set NAME): VISION_KEY, GEMINI_KEY, STRIPE_SECRET_KEY and
// STRIPE_WEBHOOK_SECRET (the Deploy backend workflow sets the Stripe ones, or "unset" until then),
// VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY (the setup makes them) for "your scan is ready" notifications.
// ENFORCE_APP_CHECK=true in functions/.env turns on App Check once the app is registered for it.

import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { onCall, onRequest, HttpsError } from 'firebase-functions/v2/https';
import { defineInt, defineSecret, defineString } from 'firebase-functions/params';
import { createHash } from 'node:crypto';
import * as prompts from './prompt.js';
import Stripe from 'stripe';
import webpush from 'web-push';
import { runScan, runAsk, jobResult, usageFor, savePushSubscription, requestNotify, ScanError } from './core.js';
import { listPlans, createCheckout, createPortal, handleEvent } from './billing.js';
import { saveReport, saveFeedback, ownerStats, isOwner } from './ops.js';

initializeApp();
const firestore = getFirestore();
// A field left undefined (say, a CeX row missing a price) is dropped rather than failing the write.
firestore.settings({ ignoreUndefinedProperties: true });

const VISION_KEY = defineSecret('VISION_KEY');
const GEMINI_KEY = defineSecret('GEMINI_KEY');
const FREE_SCANS = defineInt('FREE_SCANS', { default: 10 });
const PRO_SCANS = defineInt('PRO_SCANS', { default: 100 });
const DAILY_SCANS = defineInt('DAILY_SCANS', { default: 500 });
const PER_IP_SCANS = defineInt('PER_IP_SCANS', { default: 40 });
const FREE_ASKS = defineInt('FREE_ASKS', { default: 40 });
const PRO_ASKS = defineInt('PRO_ASKS', { default: 1000 });
const DAILY_ASKS = defineInt('DAILY_ASKS', { default: 2000 });
const GEMINI_MODEL = defineString('GEMINI_MODEL', { default: 'gemini-flash-latest' });
const GEMINI_FALLBACK_MODEL = defineString('GEMINI_FALLBACK_MODEL', { default: 'gemini-flash-lite-latest' });
const CACHE_DAYS = defineInt('CACHE_DAYS', { default: 7 });
const PASS_SCANS = defineInt('PASS_SCANS', { default: 60 });
const PASS_DAYS = defineInt('PASS_DAYS', { default: 14 });
const APP_URL = defineString('APP_URL', { default: 'https://spidyloke.github.io/shopping/' });
const OWNER_UIDS = defineString('OWNER_UIDS', { default: '' });
const owners = () => OWNER_UIDS.value().split(',').map((x) => x.trim()).filter(Boolean);
const STRIPE_SECRET_KEY = defineSecret('STRIPE_SECRET_KEY');
const VAPID_PUBLIC_KEY = defineSecret('VAPID_PUBLIC_KEY');
const VAPID_PRIVATE_KEY = defineSecret('VAPID_PRIVATE_KEY');
const STRIPE_WEBHOOK_SECRET = defineSecret('STRIPE_WEBHOOK_SECRET');

// Firestore behind the small get / set / transaction interface core.js uses.
const ref = (path) => firestore.doc(path);
const data = (snap) => (snap.exists ? snap.data() : null);
const db = {
  get: async (path) => data(await ref(path).get()),
  set: (path, value) => ref(path).set(value),
  txn: (fn) => firestore.runTransaction((tx) => fn({
    get: async (path) => data(await tx.get(ref(path))),
    set: (path, value) => { tx.set(ref(path), value); },
  })),
  // For the dashboard: how many documents (optionally where field op value), and the newest by `at`.
  count: async (collection, where) => {
    let q = firestore.collection(collection);
    if (where) q = q.where(...where);
    return (await q.count().get()).data().count;
  },
  recent: async (collection, n) => (await firestore.collection(collection).orderBy('at', 'desc').limit(n).get()).docs.map((d) => d.data()),
};

// Plan limits: read by functions that don't have the API keys, so kept apart from deps().
const limits = () => ({
  free: FREE_SCANS.value(), pro: PRO_SCANS.value(), pass: PASS_SCANS.value(), daily: DAILY_SCANS.value(), perIp: PER_IP_SCANS.value(),
  freeAsks: FREE_ASKS.value(), proAsks: PRO_ASKS.value(), dailyAsks: DAILY_ASKS.value(),
});

const deps = () => ({
  db,
  fetch,
  prompts,
  keys: { vision: VISION_KEY.value(), gemini: GEMINI_KEY.value() },
  model: GEMINI_MODEL.value(),
  push: (subscription, payload) => webpush.sendNotification(subscription, JSON.stringify(payload), {
    TTL: 6 * 60 * 60,
    vapidDetails: { subject: APP_URL.value(), publicKey: VAPID_PUBLIC_KEY.value(), privateKey: VAPID_PRIVATE_KEY.value() },
  }),
  fallbackModel: GEMINI_FALLBACK_MODEL.value(),
  cacheDays: CACHE_DAYS.value(),
  limits: limits(),
});

// Singapore is the closest region to Malaysia.
const options = {
  region: 'asia-southeast1',
  enforceAppCheck: process.env.ENFORCE_APP_CHECK === 'true',
};

function signedIn(req) {
  if (!req.auth?.uid) throw new HttpsError('unauthenticated', 'Sign in to scan.');
  return req.auth.uid;
}

const hashIp = (ip) => (ip ? createHash('sha256').update(`${process.env.GCLOUD_PROJECT}:${ip}`).digest('hex').slice(0, 24) : null);

const asHttps = (e) => (e instanceof ScanError ? new HttpsError(e.code, e.message, e.details) : e);

export const scan = onCall({ ...options, secrets: [VISION_KEY, GEMINI_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY], timeoutSeconds: 300, memory: '512MiB' }, async (req) => {
  const uid = signedIn(req);
  try {
    return await runScan(req.data, { uid, ipHash: hashIp(req.rawRequest?.ip), deps: deps() });
  } catch (e) {
    if (!(e instanceof ScanError)) console.error('scan', e); // shows in Functions → Logs
    throw asHttps(e);
  }
});

export const ask = onCall({ ...options, secrets: [VISION_KEY, GEMINI_KEY], timeoutSeconds: 180 }, async (req) => {
  const uid = signedIn(req);
  try {
    return await runAsk(req.data, { uid, ipHash: hashIp(req.rawRequest?.ip), deps: deps() });
  } catch (e) {
    throw asHttps(e);
  }
});

// Also takes { notify: true }: "Notify me" on a scan that's already running. (Folded in here rather
// than a function of its own: a new project's first deploy often fails to create new functions.)
export const result = onCall(options, async (req) => {
  const uid = signedIn(req);
  try {
    if (req.data?.notify) return await requestNotify(req.data, { uid, deps: { db } });
    return await jobResult(req.data, { uid, deps: { db } });
  } catch (e) {
    throw asHttps(e);
  }
});

// Also saves or removes this phone's notification address ({ subscription } or { removePush: true }).
export const usage = onCall({ ...options, secrets: [VAPID_PUBLIC_KEY] }, async (req) => {
  const uid = signedIn(req);
  let push;
  if (req.data?.subscription || req.data?.removePush) {
    try {
      push = await savePushSubscription({ subscription: req.data.subscription, remove: req.data.removePush === true }, { uid, deps: { db } });
    } catch (e) {
      console.error('push subscription', e);
      push = { saved: false, error: e.message };
    }
  }
  return { ...(await usageFor(uid, { db, limits: limits() })), owner: isOwner(uid, owners()), vapidPublic: VAPID_PUBLIC_KEY.value(), push };
});

// ---------- beta ----------

const handled = (fn) => async (req) => {
  const uid = signedIn(req);
  try {
    return await fn(req.data || {}, uid);
  } catch (e) {
    throw asHttps(e);
  }
};

export const report = onCall(options, handled((input, uid) => saveReport(input, { uid, deps: { db } })));
export const feedback = onCall(options, handled((input, uid) => saveFeedback(input, { uid, deps: { db } })));
export const stats = onCall(options, handled((input, uid) => ownerStats({ uid }, { deps: { db }, owners: owners() })));

// ---------- payments ----------

// The secret is "unset" until Stripe is connected; then payment calls say so instead of failing oddly.
const stripeClient = () => {
  const key = STRIPE_SECRET_KEY.value();
  return key && (key.startsWith('sk_') || key.startsWith('rk_')) ? new Stripe(key) : null;
};
const billing = () => ({ stripe: stripeClient(), db, appUrl: APP_URL.value(), passDays: PASS_DAYS.value(), limits: limits() });
const paying = { ...options, secrets: [STRIPE_SECRET_KEY] };

export const plans = onCall(paying, async (req) => {
  signedIn(req);
  try {
    return await listPlans(billing());
  } catch (e) {
    throw asHttps(e);
  }
});

export const checkout = onCall(paying, async (req) => {
  const uid = signedIn(req);
  const token = req.auth.token || {};
  try {
    return await createCheckout(req.data || {}, { uid, email: token.email, anonymous: token.firebase?.sign_in_provider === 'anonymous' }, billing());
  } catch (e) {
    throw asHttps(e);
  }
});

export const portal = onCall(paying, async (req) => {
  const uid = signedIn(req);
  try {
    return await createPortal({ uid }, billing());
  } catch (e) {
    throw asHttps(e);
  }
});

// Stripe tells the backend about payments here; the signature proves it's Stripe.
export const stripeWebhook = onRequest({ region: options.region, secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET] }, async (req, res) => {
  const stripe = stripeClient();
  if (!stripe) {
    res.status(503).send('Payments not set up');
    return;
  }
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET.value());
  } catch {
    res.status(400).send('Bad signature');
    return;
  }
  try {
    res.json({ ok: true, handled: await handleEvent(event, billing()) });
  } catch (e) {
    console.error('stripeWebhook', event.type, e);
    res.status(500).send('Not handled'); // Stripe retries
  }
});
