// Shared mocks for the end-to-end tests: Google Vision, Gemini, CeX and the exchange rate never hit
// the network. Each test describes what "Gemini" answers; calls are recorded for assertions.
const path = require('path');

const FIXTURES = path.join(__dirname, '..', 'fixtures');
const fixture = (name) => path.join(FIXTURES, name);
const THUMB = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';

// A typical answer; tests override what they care about.
function product(overrides = {}) {
  return {
    product_name: 'Sony DualSense Controller', brand: 'Sony', search_query: 'Sony DualSense', search_query_ja: 'デュアルセンス',
    price: 11480, currency: 'JPY', price_tax_included: true,
    my_new: { typical: 329 }, my_used: { typical: 220 }, jp_used_yen: null, cex_my: null,
    listings: [], my_compat: [], confidence: 'high',
    ...overrides,
  };
}

const geminiReply = (json) => ({ candidates: [{ content: { parts: [{ text: `\`\`\`json\n${JSON.stringify(json)}\n\`\`\`` }] } }] });

/**
 * Mocks every outside service for one page.
 * gemini(prompt, body) returns the JSON Gemini "answers" (or a Promise of it).
 * vision(index) returns the OCR text for each photo in a request.
 * rates maps currency → MYR.
 */
async function mockApis(page, { gemini = () => product(), vision = () => '税込 ¥11,480', cexHits = [], rates = { JPY: 0.0278, USD: 4.4, SGD: 3.3 } } = {}) {
  const calls = { gemini: [], vision: [], cex: 0, rates: [] };
  await page.route('https://api.frankfurter.dev/**', (r) => {
    const base = new URL(r.request().url()).searchParams.get('base') || 'JPY';
    calls.rates.push(base);
    r.fulfill({ json: { date: '2026-10-30', rates: { MYR: rates[base] } } });
  });
  await page.route('https://open.er-api.com/**', (r) => r.abort());
  await page.route('https://nominatim.openstreetmap.org/**', (r) => r.fulfill({ json: { address: { quarter: 'Higashi-Ikebukuro', city: 'Toshima' } } }));
  await page.route('https://search.webuy.io/**', (r) => {
    calls.cex += 1;
    r.fulfill({ headers: { 'access-control-allow-origin': '*' }, json: { results: [{ hits: cexHits }] } });
  });
  await page.route('https://vision.googleapis.com/**', (r) => {
    const body = JSON.parse(r.request().postData());
    calls.vision.push(body.requests.length);
    r.fulfill({ json: { responses: body.requests.map((_, i) => ({ fullTextAnnotation: { text: vision(i) }, webDetection: { bestGuessLabels: [{ label: 'product' }] } })) } });
  });
  await page.route('https://translation.googleapis.com/**', (r) => r.fulfill({ json: { data: { translations: [{ translatedText: 'x', detectedSourceLanguage: 'ja' }] } } }));
  await page.route('https://generativelanguage.googleapis.com/**', async (r) => {
    const body = JSON.parse(r.request().postData());
    const parts = body.contents[0].parts;
    const prompt = parts.at(-1).text;
    calls.gemini.push({ prompt, images: parts.filter((x) => x.inline_data).length, search: Boolean(body.tools) });
    r.fulfill({ json: geminiReply(await gemini(prompt, body)) });
  });
  return calls;
}

// Opens the app with an API key (and any other saved settings or scans) in place.
async function openApp(page, { settings = {}, history = null, hash = '#/' } = {}) {
  await page.goto('/');
  await page.evaluate(({ settings, history }) => {
    localStorage.setItem('kc.apiKey', '"K"');
    localStorage.setItem('kc.liveCamera', 'false');
    for (const [k, v] of Object.entries(settings)) localStorage.setItem(`kc.${k}`, JSON.stringify(v));
    if (history) localStorage.setItem('kc.history', JSON.stringify(history));
  }, { settings, history });
  await page.goto(`/${hash}`);
  await page.reload();
}

// A saved scan, for tests that start from history rather than a fresh scan.
function scan(id, ai = {}, extra = {}) {
  return {
    id, createdAt: Date.now() - id.length * 1000, thumb: THUMB, yen: 11480, currency: 'JPY', taxIncluded: true,
    status: { vision: 'done', search: 'done' }, errors: [],
    ai: { product_name: id, listings: [], my_compat: [], ...ai },
    ...extra,
  };
}

async function scanDone(page) {
  await page.waitForFunction(() => location.hash.startsWith('#/scan/'));
  await page.waitForFunction(() => !document.querySelector('#rescanBtn').disabled);
}

async function scanFromGallery(page, files = ['tag.jpg']) {
  await page.goto('/#/');
  await page.setInputFiles('#galleryInput', files.map(fixture));
  await scanDone(page);
}

const savedHistory = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('kc.history') || '[]'));

module.exports = { fixture, THUMB, product, mockApis, openApp, scan, scanDone, scanFromGallery, savedHistory };
