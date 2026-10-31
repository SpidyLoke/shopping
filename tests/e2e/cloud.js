// The Kaimono backend for app tests: the Firebase SDK is swapped for a stub whose callable functions
// run the real functions/core.js here in the test, with an in-memory Firestore and faked Google APIs.
const path = require('path');
const { product } = require('./helpers');

const ROOT = path.join(__dirname, '..', '..');
const SDK = 'https://www.gstatic.com/firebasejs/12.19.0';
const CONFIG = { apiKey: 'web', authDomain: 'kaimono-test.firebaseapp.com', projectId: 'kaimono-test', appId: '1:1:web:1' };

const STUBS = {
  app: 'export const initializeApp = (config) => ({ config });',
  // Accounts live in the page's localStorage, like Firebase's own persistence: anonymous ones are
  // anon-1, anon-2…; email accounts can be made by linking and signed into later.
  auth: `const ls = localStorage;
const read = (k, d) => JSON.parse(ls.getItem(k) || JSON.stringify(d));
let user = read('__kcUser', null);
const save = () => ls.setItem('__kcUser', JSON.stringify(user));
const fail = (code) => Object.assign(new Error(code), { code });
const wrap = () => user && { ...user, getIdToken: async () => 'token' };
export const getAuth = () => ({ get currentUser() { return wrap(); }, authStateReady: async () => {} });
export const signInAnonymously = async () => { const n = read('__kcAnon', 0) + 1; ls.setItem('__kcAnon', n); user = { uid: 'anon-' + n, isAnonymous: true, email: null }; save(); return { user: wrap() }; };
export const EmailAuthProvider = { credential: (email, password) => ({ email, password }) };
export const linkWithCredential = async (u, cred) => {
  const accounts = read('__kcAccounts', {});
  if (accounts[cred.email]) throw fail('auth/email-already-in-use');
  if (cred.password.length < 6) throw fail('auth/weak-password');
  accounts[cred.email] = { password: cred.password, uid: user.uid };
  ls.setItem('__kcAccounts', JSON.stringify(accounts));
  user = { ...user, email: cred.email, isAnonymous: false }; save();
  return { user: wrap() };
};
export const signInWithEmailAndPassword = async (a, email, password) => {
  const acc = read('__kcAccounts', {})[email];
  if (!acc || acc.password !== password) throw fail('auth/invalid-credential');
  user = { uid: acc.uid, email, isAnonymous: false }; save();
  return { user: wrap() };
};
export const sendPasswordResetEmail = async () => {};
export const signOut = async () => { user = null; save(); };`,
  functions: `export const getFunctions = (app, region) => ({ region });
export const httpsCallable = (fns, name) => async (data) => {
  const user = JSON.parse(localStorage.getItem('__kcUser') || 'null');
  const res = await fetch('/__cloud/' + name, { method: 'POST', body: JSON.stringify({ region: fns.region, data, user }) });
  const j = await res.json();
  if (j.error) { const e = new Error(j.error.message); e.code = 'functions/' + j.error.code; e.details = j.error.details; throw e; }
  return { data: j.data };
};`,
};

function fakeDb() {
  const docs = new Map();
  const copy = (v) => (v == null ? null : structuredClone(v));
  const inCol = (c) => [...docs.entries()].filter(([k]) => k.startsWith(`${c}/`)).map(([, v]) => v);
  return {
    docs,
    count: async (c, where) => inCol(c).filter((d) => !where || (where[1] === '>' ? d[where[0]] > where[2] : d[where[0]] === where[2])).length,
    recent: async (c, n) => inCol(c).sort((a, b) => b.at - a.at).slice(0, n).map(copy),
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

const ok = (body) => ({ ok: true, status: 200, json: async () => body });

const stripe = {
  prices: { list: async ({ lookup_keys: keys }) => ({ data: [
    { id: 'price_pass', lookup_key: 'kaimono_pass', unit_amount: 1990, currency: 'myr' },
    { id: 'price_month', lookup_key: 'kaimono_monthly', unit_amount: 2990, currency: 'myr' },
  ].filter((p) => keys.includes(p.lookup_key)) }) },
  checkout: { sessions: { create: async () => ({ url: 'https://checkout.stripe.com/c/pay/cs_test_1' }) } },
  billingPortal: { sessions: { create: async () => ({ url: 'https://billing.stripe.com/p/session/1' }) } },
};

// dropReplies: how many scan replies are lost on the way back (the app was closed mid-scan).
async function mockCloud(page, { ocr = '税込 ¥11,480 4948872415545', gemini = () => product({ barcode: '4948872415545', identified_by: 'barcode' }), limits = {}, dropReplies = 0, owners = [], scanHangs = false, failResult = false } = {}) {
  const core = await import(path.join(ROOT, 'functions', 'core.js'));
  const billing = await import(path.join(ROOT, 'functions', 'billing.js'));
  const ops = await import(path.join(ROOT, 'functions', 'ops.js'));
  const prompts = await import(path.join(ROOT, 'prompt.js'));
  const db = fakeDb();
  const calls = { scan: [], ask: [], result: 0, gemini: [], regions: new Set(), checkout: [], uids: new Set(), pushes: [] };
  let drops = dropReplies;
  const fetch = async (url, opt) => {
    const body = JSON.parse(opt.body);
    if (url.startsWith('https://vision')) return ok({ responses: body.requests.map(() => ({ fullTextAnnotation: { text: ocr }, webDetection: { bestGuessLabels: [{ label: 'controller' }] } })) });
    const prompt = body.contents[0].parts.at(-1).text;
    calls.gemini.push({ prompt, search: Boolean(body.tools) });
    const answer = await gemini(prompt);
    return ok({ candidates: [{ content: { parts: [{ text: typeof answer === 'string' ? answer : `\`\`\`json\n${JSON.stringify(answer)}\n\`\`\`` }] } }] });
  };
  const deps = { db, fetch, prompts, push: async (sub, payload) => { calls.pushes.push({ sub, payload }); }, keys: { vision: 'V', gemini: 'G' }, model: 'm', cexLookup: false, limits: { free: 10, pro: 300, pass: 60, daily: 100, perIp: 40, freeAsks: 40, proAsks: 1000, dailyAsks: 100, ...limits } };
  await page.route('**/firebase-config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: `export const FIREBASE = ${JSON.stringify(CONFIG)};` }));
  for (const [m, body] of Object.entries(STUBS)) await page.route(`${SDK}/firebase-${m}.js`, (r) => r.fulfill({ contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' }, body }));
  await page.route('**/__cloud/*', async (r) => {
    const name = r.request().url().split('/').pop();
    const { region, data, user } = JSON.parse(r.request().postData());
    calls.regions.add(region);
    const uid = user?.uid || 'nobody';
    calls.uids.add(uid);
    const ctx = { uid, ipHash: 'ip', deps };
    const pay = { stripe, db, appUrl: 'http://localhost:8124/', passDays: 14, limits: deps.limits };
    try {
      if (name === 'scan') calls.scan.push(data);
      if (name === 'ask') calls.ask.push(data);
      if (name === 'result') calls.result += 1;
      if (name === 'checkout') calls.checkout.push({ uid, ...data });
      if (name === 'scan' && scanHangs) { // received and running, never answers
        await db.set(`jobs/${uid}-${data.jobId}`, { uid, out: { status: 'running', startedAt: Date.now() } });
        return;
      }
      if (name === 'result' && failResult) throw Object.assign(new Error('INTERNAL'), { code: 'internal' });
      const out = name === 'scan' ? await core.runScan(data, ctx)
        : name === 'ask' ? await core.runAsk(data, ctx)
          : name === 'result' ? await core.jobResult(data, ctx)
            : name === 'plans' ? await billing.listPlans(pay)
              : name === 'checkout' ? await billing.createCheckout(data, { uid, email: user?.email, anonymous: user?.isAnonymous }, pay)
                : name === 'portal' ? await billing.createPortal({ uid }, pay)
                  : name === 'pushSubscribe' ? await core.savePushSubscription(data, { uid, deps })
                  : name === 'notifyMe' ? await core.requestNotify(data, { uid, deps })
                  : name === 'report' ? await ops.saveReport(data, { uid, deps: { db } })
                    : name === 'feedback' ? await ops.saveFeedback(data, { uid, deps: { db } })
                      : name === 'stats' ? await ops.ownerStats({ uid }, { deps: { db }, owners })
                        : { ...(await core.usageFor(uid, deps)), owner: ops.isOwner(uid, owners), vapidPublic: 'BEu4iKN6ZmWbTestPublicKey_-123' };
      if (name === 'scan' && drops > 0) {
        drops -= 1;
        await r.abort('connectionreset');
        return;
      }
      await r.fulfill({ json: { data: out } });
    } catch (e) {
      await r.fulfill({ json: { error: { code: e.code || 'internal', message: e.message, details: e.details } } });
    }
  });
  // Stripe as far as the backend sees it: prices, and the event a finished payment sends.
  let events = 0;
  const pay = (uid, plan) => billing.handleEvent({
    id: `evt_${events += 1}`,
    type: 'checkout.session.completed',
    data: { object: plan === 'pass'
      ? { mode: 'payment', payment_status: 'paid', client_reference_id: uid, customer: 'cus_1' }
      : { mode: 'subscription', payment_status: 'paid', client_reference_id: uid, subscription: { id: 'sub_1', status: 'active', customer: 'cus_1', current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400, metadata: { uid } } } },
  }, { stripe, db, passDays: 14 });
  return { db, calls, pay };
}

module.exports = { mockCloud };
