// The Kaimono backend for app tests: the Firebase SDK is swapped for a stub whose callable functions
// run the real functions/core.js here in the test, with an in-memory Firestore and faked Google APIs.
const path = require('path');
const { product } = require('./helpers');

const ROOT = path.join(__dirname, '..', '..');
const SDK = 'https://www.gstatic.com/firebasejs/12.19.0';
const CONFIG = { apiKey: 'web', authDomain: 'kaimono-test.firebaseapp.com', projectId: 'kaimono-test', appId: '1:1:web:1' };

const STUBS = {
  app: 'export const initializeApp = (config) => ({ config });',
  auth: `let user = null;
export const getAuth = () => ({ get currentUser() { return user; }, authStateReady: async () => {} });
export const signInAnonymously = async () => { user = { uid: 'anon-1', isAnonymous: true }; return { user }; };`,
  functions: `export const getFunctions = (app, region) => ({ region });
export const httpsCallable = (fns, name) => async (data) => {
  const res = await fetch('/__cloud/' + name, { method: 'POST', body: JSON.stringify({ region: fns.region, data }) });
  const j = await res.json();
  if (j.error) { const e = new Error(j.error.message); e.code = 'functions/' + j.error.code; e.details = j.error.details; throw e; }
  return { data: j.data };
};`,
};

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

const ok = (body) => ({ ok: true, status: 200, json: async () => body });

// dropReplies: how many scan replies are lost on the way back (the app was closed mid-scan).
async function mockCloud(page, { ocr = '税込 ¥11,480 4948872415545', gemini = () => product({ barcode: '4948872415545', identified_by: 'barcode' }), limits = {}, dropReplies = 0 } = {}) {
  const core = await import(path.join(ROOT, 'functions', 'core.js'));
  const prompts = await import(path.join(ROOT, 'prompt.js'));
  const db = fakeDb();
  const calls = { scan: [], ask: [], result: 0, gemini: [], regions: new Set() };
  let drops = dropReplies;
  const fetch = async (url, opt) => {
    const body = JSON.parse(opt.body);
    if (url.startsWith('https://vision')) return ok({ responses: body.requests.map(() => ({ fullTextAnnotation: { text: ocr }, webDetection: { bestGuessLabels: [{ label: 'controller' }] } })) });
    const prompt = body.contents[0].parts.at(-1).text;
    calls.gemini.push({ prompt, search: Boolean(body.tools) });
    const answer = await gemini(prompt);
    return ok({ candidates: [{ content: { parts: [{ text: typeof answer === 'string' ? answer : `\`\`\`json\n${JSON.stringify(answer)}\n\`\`\`` }] } }] });
  };
  const deps = { db, fetch, prompts, keys: { vision: 'V', gemini: 'G' }, model: 'm', cexLookup: false, limits: { free: 10, pro: 300, daily: 100, perIp: 40, freeAsks: 40, proAsks: 1000, dailyAsks: 100, ...limits } };
  await page.route('**/firebase-config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: `export const FIREBASE = ${JSON.stringify(CONFIG)};` }));
  for (const [m, body] of Object.entries(STUBS)) await page.route(`${SDK}/firebase-${m}.js`, (r) => r.fulfill({ contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' }, body }));
  await page.route('**/__cloud/*', async (r) => {
    const name = r.request().url().split('/').pop();
    const { region, data } = JSON.parse(r.request().postData());
    calls.regions.add(region);
    const ctx = { uid: 'anon-1', ipHash: 'ip', deps };
    try {
      if (name === 'scan') calls.scan.push(data);
      if (name === 'ask') calls.ask.push(data);
      if (name === 'result') calls.result += 1;
      const out = name === 'scan' ? await core.runScan(data, ctx)
        : name === 'ask' ? await core.runAsk(data, ctx)
          : name === 'result' ? await core.jobResult(data, ctx)
            : await core.usageFor('anon-1', deps);
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
  return { db, calls };
}

module.exports = { mockCloud };
