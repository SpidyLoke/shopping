// Kaimono backend on Firebase: callable functions the app uses to scan without its own API keys.
// The logic is in core.js; this file connects it to Firestore, the secrets and the settings below.
//
// Settings (functions/.env, or asked for on first deploy):
//   FREE_SCANS    scans a month on the free plan (default 10)
//   PRO_SCANS     scans a month on the paid plan (default 300)
//   DAILY_SCANS   most scans the whole app runs in a day, so a bug or abuse can't run up the bill (default 500)
//   PER_IP_SCANS  most scans from one connection in a day (default 40)
//   FREE_ASKS, PRO_ASKS, DAILY_ASKS  the same for questions (Worth it, Ask, shelf, Compare): 40, 1000, 2000
//   GEMINI_MODEL  (default gemini-flash-latest)
//   CACHE_DAYS    how long a barcode's market prices are reused (default 7)
// Secrets (firebase functions:secrets:set NAME): VISION_KEY, GEMINI_KEY.
// ENFORCE_APP_CHECK=true in functions/.env turns on App Check once the app is registered for it.

import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { defineInt, defineSecret, defineString } from 'firebase-functions/params';
import { createHash } from 'node:crypto';
import * as prompts from './prompt.js';
import { runScan, runAsk, jobResult, usageFor, ScanError } from './core.js';

initializeApp();
const firestore = getFirestore();

const VISION_KEY = defineSecret('VISION_KEY');
const GEMINI_KEY = defineSecret('GEMINI_KEY');
const FREE_SCANS = defineInt('FREE_SCANS', { default: 10 });
const PRO_SCANS = defineInt('PRO_SCANS', { default: 300 });
const DAILY_SCANS = defineInt('DAILY_SCANS', { default: 500 });
const PER_IP_SCANS = defineInt('PER_IP_SCANS', { default: 40 });
const FREE_ASKS = defineInt('FREE_ASKS', { default: 40 });
const PRO_ASKS = defineInt('PRO_ASKS', { default: 1000 });
const DAILY_ASKS = defineInt('DAILY_ASKS', { default: 2000 });
const GEMINI_MODEL = defineString('GEMINI_MODEL', { default: 'gemini-flash-latest' });
const CACHE_DAYS = defineInt('CACHE_DAYS', { default: 7 });

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
};

const deps = () => ({
  db,
  fetch,
  prompts,
  keys: { vision: VISION_KEY.value(), gemini: GEMINI_KEY.value() },
  model: GEMINI_MODEL.value(),
  cacheDays: CACHE_DAYS.value(),
  limits: {
    free: FREE_SCANS.value(), pro: PRO_SCANS.value(), daily: DAILY_SCANS.value(), perIp: PER_IP_SCANS.value(),
    freeAsks: FREE_ASKS.value(), proAsks: PRO_ASKS.value(), dailyAsks: DAILY_ASKS.value(),
  },
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

export const scan = onCall({ ...options, secrets: [VISION_KEY, GEMINI_KEY], timeoutSeconds: 300, memory: '512MiB' }, async (req) => {
  const uid = signedIn(req);
  try {
    return await runScan(req.data, { uid, ipHash: hashIp(req.rawRequest?.ip), deps: deps() });
  } catch (e) {
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

export const result = onCall(options, async (req) => {
  const uid = signedIn(req);
  try {
    return await jobResult(req.data, { uid, deps: { db } });
  } catch (e) {
    throw asHttps(e);
  }
});

export const usage = onCall(options, async (req) => {
  const uid = signedIn(req);
  return usageFor(uid, { db, limits: deps().limits });
});
