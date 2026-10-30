// The background scan server (server/Code.gs and server/Loader.gs) run in a fake Apps Script sandbox.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const makeServer = require('./gas');

const CODE = path.join(__dirname, '..', '..', 'server', 'Code.gs');
const LOADER = path.join(__dirname, '..', '..', 'server', 'Loader.gs');
const reply = (code, body) => ({ getResponseCode: () => code, getContentText: () => (typeof body === 'string' ? body : JSON.stringify(body)) });

function scanServer(log = []) {
  return makeServer(CODE, {
    log,
    fetchImpl: (url, opt) => {
      if (url.startsWith('https://vision')) {
        const n = JSON.parse(opt.payload).requests.length;
        return reply(200, { responses: Array.from({ length: n }, (_, i) => ({ fullTextAnnotation: { text: i ? 'label' : '中古 ランクB 税込 ¥21,800' }, webDetection: { bestGuessLabels: [{ label: 'victrix pro bfg' }] } })) });
      }
      if (url.startsWith('https://generativelanguage')) {
        const text = JSON.parse(opt.payload).contents[0].parts.at(-1).text;
        if (text.includes('{{')) return reply(500, { error: { message: 'placeholders not replaced' } });
        return reply(200, { candidates: [{ content: { parts: [{ text: '```json\n{"product_name":"Victrix Pro BFG","search_query":"Victrix Pro BFG","price":21800,"currency":"JPY"}\n```' }] } }] });
      }
      if (url.startsWith('https://search.webuy.io')) return reply(200, { results: [{ hits: [{ boxId: 'B1', boxName: 'Victrix Pro BFG (PS5), B', sellPrice: 650, cashPriceCalculated: 330, exchangePriceCalculated: 400, junk: 'x'.repeat(50) }] }] });
      if (url.startsWith('https://ntfy.sh')) return reply(200, {});
      return reply(404, {});
    },
  });
}

const job = (extra = {}) => ({ action: 'scan', secret: 'abc', jobId: 'j1', image: 'IMG1', keys: { cloud: 'C', gemini: 'G' }, model: 'm', referer: 'https://example.github.io/shopping/', vision: true, prompt: 'OCR:"""{{OCR}}""" guess "{{WEBGUESS}}"', cex: { index: 'prod_cex_my' }, ...extra });

test('the first caller claims the server; others are refused', () => {
  const s = scanServer();
  assert.deepEqual(s.doPost({ action: 'ping' }), { error: 'Missing secret' });
  assert.equal(s.doPost({ action: 'ping', secret: 'abc' }).ok, true);
  assert.match(s.doPost({ action: 'ping', secret: 'zzz' }).error, /another copy/);
});

test('a scan runs Vision, Gemini and CeX, keeps the result and sends the referer', () => {
  const log = [];
  const s = scanServer(log);
  const out = s.doPost(job());
  assert.equal(out.status, 'done');
  assert.match(out.vision.ocrText, /ランクB/);
  assert.match(out.gemini.text, /Victrix/);
  assert.deepEqual(Object.keys(out.cex.hits[0]).sort(), ['boxId', 'boxName', 'cashPriceCalculated', 'exchangePriceCalculated', 'sellPrice']);
  assert.equal(s.doPost({ action: 'result', secret: 'abc', jobId: 'j1' }).status, 'done');
  assert.equal(s.doPost({ action: 'result', secret: 'abc', jobId: 'nope' }).status, 'unknown');
  assert.ok(log.filter((l) => /googleapis/.test(l.url)).every((l) => l.opt.headers.Referer === 'https://example.github.io/shopping/'));
  assert.ok(log.find((l) => l.url.includes('generativelanguage')).url.includes('key=G'));
});

test('extra photos go to Vision in one batch and to Gemini; cex: null skips CeX', () => {
  const log = [];
  const s = scanServer(log);
  const out = s.doPost(job({ moreImages: ['IMG2', 'IMG3'], cex: null }));
  assert.equal(JSON.parse(log.find((l) => l.url.includes('vision')).opt.payload).requests.length, 3);
  const gemini = JSON.parse(log.find((l) => l.url.includes('generativelanguage')).opt.payload);
  assert.equal(gemini.contents[0].parts.filter((p) => p.inline_data).length, 3);
  assert.equal(log.filter((l) => l.url.includes('webuy')).length, 0);
  assert.match(out.vision.ocrText, /label/);
});

test('a crash still answers in JSON (an error page would show as "Load failed")', () => {
  const s = makeServer(CODE, { fetchImpl: () => reply(200, {}) });
  vm.runInContext("CacheService = { getScriptCache: () => ({ put: () => { throw new Error('Service invoked too many times'); }, get: () => null }) };", s.ctx);
  assert.match(s.doPost({ action: 'scan', secret: 'a', jobId: 'j' }).error, /Service invoked too many times/);
});

test('ntfy is retried on network errors, then gives up', () => {
  let attempts = 0;
  let failFirst = 2;
  const s = makeServer(CODE, {
    fetchImpl: (url) => {
      if (!url.startsWith('https://ntfy.sh')) return reply(404, {});
      attempts += 1;
      if (attempts <= failFirst) throw new Error('Address unavailable: https://ntfy.sh/');
      return reply(200, {});
    },
  });
  assert.equal(s.doPost({ action: 'ping', secret: 'a', notify: { topic: 't' } }).ntfy.code, 200);
  attempts = 0;
  failFirst = 99;
  assert.equal(s.doPost({ action: 'ping', secret: 'a', notify: { topic: 't' } }).ntfy.code, 0);
});

test('the loader fetches the server code from GitHub once and caches it', () => {
  const code = fs.readFileSync(CODE, 'utf8');
  let fetches = 0;
  const s = makeServer(LOADER, {
    fetchImpl: (url) => {
      if (url.includes('raw.githubusercontent.com')) {
        fetches += 1;
        return reply(200, code);
      }
      return reply(404, {});
    },
  });
  assert.equal(s.doPost({ action: 'ping', secret: 's1' }).ok, true);
  assert.equal(s.doPost({ action: 'ping', secret: 's1' }).ok, true);
  assert.equal(fetches, 1);
});
