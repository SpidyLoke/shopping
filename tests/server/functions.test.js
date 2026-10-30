// The Firebase backend (functions/core.js) with an in-memory Firestore and faked Google APIs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const load = async () => ({
  core: await import(path.join(ROOT, 'functions', 'core.js')),
  prompts: await import(path.join(ROOT, 'functions', 'prompt.js')),
});

// Firestore stand-in: documents by path; a transaction reads then writes, all or nothing.
function fakeDb() {
  const docs = new Map();
  const copy = (v) => (v == null ? null : structuredClone(v));
  return {
    docs,
    get: async (p) => copy(docs.get(p)),
    set: async (p, v) => { docs.set(p, copy(v)); },
    txn: async (fn) => {
      const writes = new Map();
      const result = await fn({ get: async (p) => copy(docs.get(p)), set: (p, v) => writes.set(p, copy(v)) });
      for (const [p, v] of writes) docs.set(p, v);
      return result;
    },
  };
}

const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
const fenced = (o) => ({ candidates: [{ content: { parts: [{ text: `\`\`\`json\n${JSON.stringify(o)}\n\`\`\`` }] }, groundingMetadata: { groundingChunks: [{ web: { title: 'shopee.com.my', uri: 'https://shopee.com.my/x' } }] } }] });
const MARKET = { product_name: 'Sony DualSense', search_query: 'Sony DualSense', my_new: { typical: 329 }, my_used: { typical: 220 }, listings: [], barcode: '4948872415545', identified_by: 'barcode' };

function apis({ ocr = '税込 ¥8,980 4948872415545', gemini = () => ({ ...MARKET, price: 8980, currency: 'JPY' }), geminiStatus = 200 } = {}) {
  const calls = { vision: 0, gemini: [], cex: 0 };
  const fetch = async (url, opt) => {
    const body = JSON.parse(opt.body);
    if (url.startsWith('https://vision')) {
      calls.vision += 1;
      return json(200, { responses: body.requests.map(() => ({ fullTextAnnotation: { text: ocr }, webDetection: { bestGuessLabels: [{ label: 'controller' }] } })) });
    }
    if (url.startsWith('https://generativelanguage')) {
      const prompt = body.contents[0].parts.at(-1).text;
      calls.gemini.push({ prompt, search: Boolean(body.tools), url });
      return geminiStatus >= 400 ? json(geminiStatus, { error: { message: 'quota exceeded' } }) : json(200, fenced(gemini(prompt)));
    }
    if (url.startsWith('https://search.webuy.io')) {
      calls.cex += 1;
      return json(200, { results: [{ hits: [{ boxId: 'D1', boxName: 'DualSense, B', sellPrice: 199, cashPriceCalculated: 90, exchangePriceCalculated: 120, extra: 'x' }] }] });
    }
    throw new Error(`unexpected ${url}`);
  };
  return { fetch, calls };
}

const IMG = 'A'.repeat(200);
const LIMITS = { free: 3, pro: 300, daily: 100, perIp: 40, freeAsks: 2, proAsks: 100, dailyAsks: 100 };

async function setup(opts = {}) {
  const { core, prompts } = await load();
  const db = fakeDb();
  const { fetch, calls } = apis(opts);
  let now = Date.UTC(2026, 9, 30, 4);
  const deps = { db, fetch, prompts, keys: { vision: 'V', gemini: 'G' }, model: 'm', cexIndex: 'prod_cex_my', limits: { ...LIMITS, ...opts.limits }, clock: () => now };
  const scan = (input = {}, uid = 'u1', ipHash = 'ip1') => core.runScan({ images: [IMG], ...input }, { uid, ipHash, deps });
  return { core, db, calls, deps, scan, setNow: (t) => { now = t; } };
}

test('functions/prompt.js is the same file as prompt.js (run: cp prompt.js functions/)', () => {
  assert.equal(fs.readFileSync(path.join(ROOT, 'functions', 'prompt.js'), 'utf8'), fs.readFileSync(path.join(ROOT, 'prompt.js'), 'utf8'));
});

test('a scan uses the server keys, reads the barcode, searches and counts against the allowance', async () => {
  const { scan, calls, db } = await setup();
  const out = await scan({ jobId: 'j1' });
  assert.equal(out.status, 'done');
  assert.match(out.vision.ocrText, /4948872415545/);
  assert.equal(calls.gemini.length, 1);
  assert.ok(calls.gemini[0].search);
  assert.ok(calls.gemini[0].url.includes('key=G'));
  assert.match(calls.gemini[0].prompt, /These barcode numbers were found in the text: 4948872415545/);
  assert.deepEqual(Object.keys(out.cex.hits[0]).sort(), ['boxId', 'boxName', 'cashPriceCalculated', 'exchangePriceCalculated', 'sellPrice']);
  assert.deepEqual({ used: out.usage.used, limit: out.usage.limit, plan: out.usage.plan }, { used: 1, limit: 3, plan: 'free' });
  assert.equal(db.docs.get('jobs/u1-j1').out.status, 'done');
  assert.ok(db.docs.get('products/4948872415545-new'), 'market prices kept for the barcode');
});

test('the same barcode again reuses the prices: no search, tag read only, and it is free', async () => {
  const { scan, calls } = await setup();
  await scan();
  const out = await scan({}, 'u2');
  assert.equal(calls.gemini.length, 2);
  assert.equal(calls.gemini[1].search, false);
  assert.match(calls.gemini[1].prompt, /Read only what the tag/);
  assert.ok(out.cached);
  assert.equal(out.usage.used, 0);
  const ai = JSON.parse(out.gemini.text.replace(/```json|```/g, ''));
  assert.equal(ai.my_new.typical, 329);
  assert.equal(out.gemini.chunks.length, 1);
});

test('the cache is per condition, skipped for corrected names, and expires', async () => {
  const { scan, calls, setNow } = await setup({ limits: { free: 10 } });
  await scan();
  await scan({ secondHand: true });
  assert.equal(calls.gemini.at(-1).search, true, 'used is priced separately');
  await scan({ override: 'Sony DualSense Edge' });
  assert.equal(calls.gemini.at(-1).search, true, 'a corrected name is never answered from the cache');
  setNow(Date.UTC(2026, 10, 9));
  await scan();
  assert.equal(calls.gemini.at(-1).search, true, 'older than 7 days');
});

test('a barcode Gemini did not match is not cached', async () => {
  const { scan, db } = await setup({ gemini: () => ({ ...MARKET, barcode: null, identified_by: 'appearance' }) });
  await scan();
  assert.equal(db.docs.has('products/4948872415545-new'), false);
});

test('the monthly allowance runs out, then resets on the 1st (Malaysia time)', async () => {
  const { scan, setNow } = await setup({ ocr: '¥3,000' });
  for (let i = 0; i < 3; i += 1) await scan();
  await assert.rejects(scan(), (e) => e.code === 'resource-exhausted' && e.details.reason === 'quota' && e.details.limit === 3);
  setNow(Date.UTC(2026, 9, 31, 16, 1)); // 00:01 on 1 Nov in Malaysia
  assert.equal((await scan()).usage.used, 1);
});

test('a failed Gemini call gives the scan back', async () => {
  const { scan } = await setup({ geminiStatus: 429 });
  const out = await scan();
  assert.match(out.geminiError, /quota exceeded/);
  assert.equal(out.usage.used, 0);
});

test('daily and per-connection caps protect the bill', async () => {
  const daily = await setup({ ocr: '¥3,000', limits: { daily: 2, free: 10 } });
  await daily.scan({}, 'a');
  await daily.scan({}, 'b');
  await assert.rejects(daily.scan({}, 'c'), (e) => e.details.reason === 'daily');
  const conn = await setup({ ocr: '¥3,000', limits: { perIp: 1, free: 10 } });
  await conn.scan({}, 'a', 'same');
  await assert.rejects(conn.scan({}, 'b', 'same'), (e) => e.details.reason === 'connection');
});

test('bad input is refused before anything is spent', async () => {
  const { scan, calls, db } = await setup();
  await assert.rejects(scan({ images: [] }), (e) => e.code === 'invalid-argument');
  await assert.rejects(scan({ images: Array(6).fill(IMG) }), (e) => e.code === 'invalid-argument');
  assert.equal(calls.vision, 0);
  assert.equal(db.docs.size, 0);
});

test('a job result is only given to the user who ran it', async () => {
  const { core, scan, deps } = await setup();
  await scan({ jobId: 'abc' });
  assert.equal((await core.jobResult({ jobId: 'abc' }, { uid: 'u1', deps })).status, 'done');
  assert.equal((await core.jobResult({ jobId: 'abc' }, { uid: 'someone' , deps })).status, 'unknown');
});

test('clothes skip CeX and the cache', async () => {
  const { scan, calls, db } = await setup();
  await scan({ clothes: true });
  assert.equal(calls.cex, 0);
  assert.equal(db.docs.has('products/4948872415545-new'), false);
});

test('asks: Gemini with or without search, or Vision only, from their own allowance', async () => {
  const { core, deps, calls, db } = await setup();
  const r = await core.runAsk({ prompt: 'Is it worth it?', search: true }, { uid: 'u1', deps });
  assert.match(r.text, /DualSense/);
  assert.equal(calls.gemini.at(-1).search, true);
  const o = await core.runAsk({ images: [IMG], ocrOnly: true }, { uid: 'u1', deps });
  assert.match(o.ocrText, /¥8,980/);
  assert.deepEqual(o.asks, { used: 2, limit: 2 });
  await assert.rejects(core.runAsk({ prompt: 'again' }, { uid: 'u1', deps }), (e) => e.details.reason === 'asks');
  assert.equal(db.docs.get('users/u1').used, undefined, 'scans allowance untouched');
  await assert.rejects(core.runAsk({ prompt: 'x'.repeat(20000) }, { uid: 'u2', deps }), (e) => e.code === 'invalid-argument');
});

test('a failed ask is given back', async () => {
  const { core, deps, db } = await setup({ geminiStatus: 500 });
  await assert.rejects(core.runAsk({ prompt: 'hi' }, { uid: 'u1', deps }), (e) => e.code === 'unavailable');
  assert.equal(db.docs.get('users/u1').asksUsed, 0);
});
