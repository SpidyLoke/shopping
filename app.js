// Kaimono Check: photo → Google Vision OCR → Google Translate → Gemini (with Google Search)
// for Shopee / Carousell Malaysia prices. Everything runs in the browser; the API key
// lives in localStorage on the user's device only.

const DEFAULT_MODEL = 'gemini-flash-latest';
const HISTORY_LIMIT = 80;
const RATE_TTL_MS = 6 * 60 * 60 * 1000;
const TAX = 0.10;
const TAX_FREE_MIN_YEN = 5000;

const $ = (sel) => document.querySelector(sel);

// ---------- storage ----------

const store = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(`kc.${key}`);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`kc.${key}`, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },
};

const settings = {
  get apiKey() { return store.get('apiKey', ''); },
  // Google won't let a restricted key cover Gemini plus other APIs, so Gemini can have its own key.
  get geminiKey() { return store.get('geminiKey', '') || this.apiKey; },
  get model() { return store.get('model', '') || DEFAULT_MODEL; },
  get taxFree() { return store.get('taxFree', false); },
};

function loadHistory() {
  const list = store.get('history', []);
  return Array.isArray(list) ? list : [];
}

function saveEntry(entry) {
  let list = loadHistory().filter((e) => e.id !== entry.id);
  list.unshift(entry);
  list.sort((a, b) => b.createdAt - a.createdAt);
  list = list.slice(0, HISTORY_LIMIT);
  // On quota errors, drop the oldest scans until it fits.
  while (!store.set('history', list) && list.length > 1) list.pop();
}

function deleteEntry(id) {
  store.set('history', loadHistory().filter((e) => e.id !== id));
}

function findEntry(id) {
  if (running.has(id)) return running.get(id);
  if (current && current.id === id) return current;
  return loadHistory().find((e) => e.id === id) || null;
}

// ---------- helpers ----------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function safeUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function toNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const m = v.replace(/[,，\s]/g, '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function rm(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  const dp = Math.abs(n) < 100 ? 2 : 0;
  return `RM ${n.toLocaleString('en-MY', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
}

function yen(n) {
  return `¥${Math.round(n).toLocaleString('en-GB')}`;
}

const dateFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ---------- images ----------

async function decodeImage(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  }
}

function toJpeg(src, maxSide, quality) {
  const w = src.naturalWidth || src.width;
  const h = src.naturalHeight || src.height;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext('2d').drawImage(src, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

// ---------- exchange rate ----------

let rate = null;

async function fetchRate() {
  const cached = store.get('rate');
  if (cached && Date.now() - cached.fetchedAt < RATE_TTL_MS) {
    rate = cached;
    return rate;
  }
  const sources = [
    async () => {
      const r = await fetch('https://api.frankfurter.dev/v1/latest?base=JPY&symbols=MYR');
      const d = await r.json();
      return { value: d.rates.MYR, date: d.date };
    },
    async () => {
      const r = await fetch('https://open.er-api.com/v6/latest/JPY');
      const d = await r.json();
      return { value: d.rates.MYR, date: (d.time_last_update_utc || '').slice(5, 16) };
    },
  ];
  for (const src of sources) {
    try {
      const { value, date } = await src();
      if (Number.isFinite(value) && value > 0) {
        rate = { value, date, fetchedAt: Date.now() };
        store.set('rate', rate);
        return rate;
      }
    } catch {
      // try the next source
    }
  }
  rate = cached || null;
  return rate;
}

function renderRate() {
  const pill = $('#ratePill');
  if (!rate) {
    pill.textContent = 'Exchange rate unavailable (offline?)';
    return;
  }
  pill.textContent = `¥1,000 = ${rm(rate.value * 1000)}${rate.date ? ` · ${rate.date}` : ''}`;
}

// ---------- Google APIs ----------

async function googlePost(url, body, service, key = settings.apiKey) {
  let res;
  try {
    res = await fetch(`${url}?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(`${service}: network error. Check your connection.`);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    // non-JSON error body
  }
  if (!res.ok) throw new Error(`${service}: ${data?.error?.message || `HTTP ${res.status}`}`);
  return data;
}

async function readImage(b64) {
  const data = await googlePost('https://vision.googleapis.com/v1/images:annotate', {
    requests: [{
      image: { content: b64 },
      features: [{ type: 'DOCUMENT_TEXT_DETECTION' }, { type: 'WEB_DETECTION', maxResults: 5 }],
      imageContext: { languageHints: ['ja', 'en'] },
    }],
  }, 'Vision');
  const r = data.responses?.[0] || {};
  if (r.error) throw new Error(`Vision: ${r.error.message}`);
  return {
    ocrText: (r.fullTextAnnotation?.text || '').trim(),
    webGuess: r.webDetection?.bestGuessLabels?.[0]?.label || '',
  };
}

async function translate(text) {
  const data = await googlePost('https://translation.googleapis.com/language/translate/v2', {
    q: text,
    target: 'en',
    format: 'text',
  }, 'Translate');
  const t = data.data?.translations?.[0] || {};
  return { translation: t.translatedText || '', sourceLang: t.detectedSourceLanguage || '' };
}

function buildPrompt({ ocrText, webGuess }) {
  return `You are helping a Malaysian shopper standing in a shop in Japan decide whether to buy an item here or back home in Malaysia.

The attached photo shows a product, box, price tag or shelf label in a Japanese shop.
OCR text from the photo:
"""
${ocrText || '(none detected)'}
"""
Google's visual best guess for the photo: "${webGuess || 'none'}"

Tasks:
1. Identify the exact product: brand, model or variant, size or capacity.
2. Read the Japanese shop price in yen from the photo or OCR text. If both tax-inclusive (税込) and tax-exclusive (税抜) prices are shown, use the tax-inclusive one. Say whether the number you picked includes Japan's 10% consumption tax. Use null if no price is visible.
3. Use Google Search to find current prices in Malaysia, in RM, for the same product:
   - New: Shopee Malaysia (shopee.com.my). If Shopee has none, use Lazada Malaysia or official Malaysian retailers.
   - Second-hand: Carousell Malaysia (carousell.com.my), plus used listings on Shopee Malaysia.
   Only use Malaysian listings priced in RM. Exclude accessories, cases, spare parts and different variants. Never invent listings, prices or URLs; if you cannot find any, use null or an empty list.

Reply with only a JSON object inside a \`\`\`json code block, with exactly these keys:
{
  "product_name": "concise English product name",
  "brand": "brand or null",
  "search_query": "best English query to type into Shopee or Carousell (brand + model)",
  "jp_price_yen": 12800,
  "jp_price_tax_included": true,
  "jp_price_note": "short note on which price was read, or null",
  "my_new": { "low": 0, "high": 0, "typical": 0 },
  "my_used": { "low": 0, "high": 0, "typical": 0 },
  "listings": [
    { "platform": "Shopee | Carousell | Lazada | Other", "condition": "new | used", "title": "listing title", "price_rm": 0, "url": "listing URL or null" }
  ],
  "confidence": "high | medium | low",
  "notes": "one or two sentences on matching caveats (Japan-only variant, voltage, region lock, etc.)"
}
Use null for any price you could not find.`;
}

function parseJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('Gemini: answer was not in the expected format. Try again.');
  return JSON.parse(body.slice(start, end + 1));
}

async function askGemini({ imageB64, ocrText, webGuess }) {
  const parts = [];
  if (imageB64) parts.push({ inline_data: { mime_type: 'image/jpeg', data: imageB64 } });
  parts.push({ text: buildPrompt({ ocrText, webGuess }) });
  const data = await googlePost(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(settings.model)}:generateContent`,
    { contents: [{ role: 'user', parts }], tools: [{ google_search: {} }] },
    'Gemini',
    settings.geminiKey,
  );
  const cand = data.candidates?.[0];
  const text = (cand?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
  if (!text) {
    const why = cand?.finishReason || data.promptFeedback?.blockReason || 'no reason given';
    throw new Error(`Gemini returned no answer (${why}).`);
  }
  const sources = (cand.groundingMetadata?.groundingChunks || [])
    .map((c) => c.web)
    .filter((w) => w && safeUrl(w.uri))
    .map((w) => ({ title: w.title || w.uri, url: w.uri }));
  return { ai: parseJson(text), sources };
}

// Fallback yen reader for when Gemini gives no price: prefers numbers on a 税込 line.
function parseYen(text) {
  if (!text) return null;
  let best = null;
  for (const line of text.split('\n')) {
    const re = /[¥￥]\s*([\d,，]{2,9})|([\d,，]{2,9})\s*円/g;
    let m;
    while ((m = re.exec(line))) {
      const n = toNum(m[1] || m[2]);
      if (!n || n < 10) continue;
      const score = /税込/.test(line) ? 2 : 1;
      if (!best || score > best.score) best = { n, score };
    }
  }
  return best ? best.n : null;
}

// ---------- pricing & verdict ----------

function rangeValue(r) {
  if (!r) return null;
  const typical = toNum(r.typical);
  if (typical) return typical;
  const lo = toNum(r.low);
  const hi = toNum(r.high);
  if (lo && hi) return (lo + hi) / 2;
  return lo || hi || null;
}

function japanPrice(entry) {
  const fx = rate?.value || entry.rate || null;
  const y = toNum(entry.yen);
  if (!y) return { rm: null, note: 'Type the tag price' };
  let payYen = entry.taxIncluded === false ? y * (1 + TAX) : y;
  let note = entry.taxIncluded === false ? `${yen(payYen)} with tax` : '';
  if (entry.taxFree) {
    if (payYen >= TAX_FREE_MIN_YEN) {
      payYen /= 1 + TAX;
      note = `${yen(payYen)} after refund`;
    } else {
      note = 'Under ¥5,000, no refund';
    }
  }
  if (!fx) return { rm: null, note: 'No exchange rate' };
  return { rm: payYen * fx, note };
}

function verdictFor(entry) {
  const jp = japanPrice(entry).rm;
  const myNew = rangeValue(entry.ai?.my_new);
  const myUsed = rangeValue(entry.ai?.my_used);
  if (!entry.ai) return null;
  if (!jp) return { cls: 'none', label: 'Need the yen price', detail: 'Type the price from the tag to get a verdict.' };
  if (!myNew && !myUsed) return { cls: 'none', label: 'No Malaysian prices found', detail: 'Check the Shopee and Carousell links below.' };

  const pct = (a, b) => Math.round((a / b) * 100);
  if (myNew) {
    const save = myNew - jp;
    if (jp <= myNew * 0.9) {
      if (myUsed && myUsed < jp) {
        return {
          cls: 'maybe',
          label: 'Buy if you want it new',
          detail: `${rm(save)} cheaper than new in Malaysia (${pct(save, myNew)}% less), but second-hand there is ${rm(jp - myUsed)} less than this.`,
        };
      }
      return { cls: 'buy', label: 'Buy it here', detail: `${rm(save)} cheaper than new in Malaysia (${pct(save, myNew)}% less).` };
    }
    if (save > 0) {
      return { cls: 'maybe', label: 'Marginal', detail: `Only ${rm(save)} cheaper than new in Malaysia (${pct(save, myNew)}% less).` };
    }
    return { cls: 'skip', label: 'Skip it', detail: `${rm(-save)} cheaper new in Malaysia.` };
  }
  if (myUsed < jp) {
    return { cls: 'maybe', label: 'Cheaper second-hand at home', detail: `Second-hand in Malaysia is ${rm(jp - myUsed)} less. No new listings found.` };
  }
  return { cls: 'buy', label: 'Buy it here', detail: `Even second-hand costs ${rm(myUsed - jp)} more in Malaysia. No new listings found.` };
}

function searchQuery(entry) {
  return entry.ai?.search_query || entry.ai?.product_name || entry.webGuess || (entry.translation || '').split('\n')[0] || '';
}

// ---------- scanning ----------

let current = null;
let currentImageB64 = null;
const running = new Map(); // id → entry for scans still in flight

async function startScan(file) {
  if (!file) return;
  if (!settings.apiKey) {
    openSettings();
    return;
  }

  let full;
  let thumb;
  try {
    const src = await decodeImage(file);
    full = toJpeg(src, 1600, 0.85);
    thumb = toJpeg(src, 320, 0.7);
    src.close?.();
  } catch {
    alert('Could not open that image. Try another photo.');
    return;
  }

  const entry = {
    id: uid(),
    createdAt: Date.now(),
    thumb,
    ocrText: '',
    webGuess: '',
    translation: '',
    sourceLang: '',
    ai: null,
    sources: [],
    yen: null,
    taxIncluded: true,
    taxFree: settings.taxFree,
    rate: rate?.value || null,
    status: { vision: 'active', translate: 'pending', search: 'pending' },
    errors: [],
  };
  current = entry;
  currentImageB64 = full.split(',')[1];
  running.set(entry.id, entry);
  saveEntry(entry);
  location.hash = `#/scan/${entry.id}`;

  const update = () => {
    saveEntry(entry);
    if (location.hash === `#/scan/${entry.id}`) renderResult(entry);
  };

  try {
    Object.assign(entry, await readImage(currentImageB64));
    entry.status.vision = 'done';
  } catch (e) {
    entry.status.vision = 'failed';
    entry.errors.push(e.message);
  }
  if (!entry.yen) entry.yen = parseYen(entry.ocrText);
  entry.status.translate = entry.ocrText ? 'active' : 'skipped';
  update();

  const translating = entry.ocrText
    ? translate(entry.ocrText)
      .then((t) => {
        Object.assign(entry, t);
        entry.status.translate = 'done';
      })
      .catch((e) => {
        entry.status.translate = 'failed';
        entry.errors.push(e.message);
      })
      .finally(update)
    : Promise.resolve();

  await Promise.all([translating, searchPrices(entry, currentImageB64, update)]);
  if (!entry.rate && rate) entry.rate = rate.value;
  running.delete(entry.id);
  update();
}

async function searchPrices(entry, imageB64, update) {
  entry.status.search = 'active';
  entry.errors = entry.errors.filter((m) => !m.startsWith('Gemini'));
  update();
  try {
    const { ai, sources } = await askGemini({ imageB64, ocrText: entry.ocrText, webGuess: entry.webGuess });
    entry.ai = ai;
    entry.sources = sources;
    if (!entry.yenEdited) {
      entry.yen = toNum(ai.jp_price_yen) || entry.yen || parseYen(entry.ocrText);
      if (typeof ai.jp_price_tax_included === 'boolean') entry.taxIncluded = ai.jp_price_tax_included;
    }
    entry.status.search = 'done';
  } catch (e) {
    entry.status.search = 'failed';
    entry.errors.push(e.message);
  }
  update();
}

async function retrySearch() {
  const entry = current;
  if (!entry || running.has(entry.id)) return;
  running.set(entry.id, entry);
  const image = currentImageB64 || entry.thumb.split(',')[1];
  const update = () => {
    saveEntry(entry);
    if (location.hash === `#/scan/${entry.id}`) renderResult(entry);
  };
  await searchPrices(entry, image, update);
  running.delete(entry.id);
  update();
}

// ---------- rendering ----------

const views = ['homeView', 'resultView', 'historyView'];

function show(viewId) {
  for (const v of views) $(`#${v}`).hidden = v !== viewId;
  window.scrollTo(0, 0);
}

function historyItem(entry) {
  const jp = japanPrice(entry).rm;
  const v = verdictFor(entry);
  const tagCls = { buy: 'tag-buy', maybe: 'tag-maybe', skip: 'tag-skip' }[v?.cls] || '';
  const tagText = { buy: 'Buy', maybe: 'Maybe', skip: 'Skip' }[v?.cls] || (running.has(entry.id) ? '…' : '–');
  const meta = [toNum(entry.yen) ? yen(entry.yen) : null, jp ? rm(jp) : null, dateFmt.format(entry.createdAt)].filter(Boolean).join(' · ');
  return el('li', {},
    el('button', { class: 'history-item', type: 'button', onclick: () => { location.hash = `#/scan/${entry.id}`; } },
      el('img', { src: entry.thumb, alt: '' }),
      el('div', { class: 'history-body' },
        el('p', { class: 'history-name' }, entry.ai?.product_name || entry.webGuess || 'Unidentified item'),
        el('p', { class: 'history-meta' }, meta),
      ),
      el('span', { class: `tag ${tagCls}` }, tagText),
    ),
  );
}

function renderHome() {
  $('#keyNotice').hidden = Boolean(settings.apiKey);
  const list = loadHistory().slice(0, 3);
  $('#recentWrap').hidden = list.length === 0;
  $('#recentList').replaceChildren(...list.map(historyItem));
  renderRate();
}

function renderHistory() {
  const list = loadHistory();
  $('#historyEmpty').hidden = list.length > 0;
  $('#historyList').replaceChildren(...list.map(historyItem));
}

function renderSteps(entry) {
  const isRunning = running.has(entry.id);
  const states = Object.values(entry.status);
  const anyFailed = states.includes('failed') || (!isRunning && states.includes('active'));
  $('#steps').hidden = !isRunning && !anyFailed;
  for (const li of $('#steps').children) {
    let s = entry.status[li.dataset.step];
    if (s === 'active' && !isRunning) s = 'failed';
    li.className = { active: 'active', done: 'done', failed: 'failed' }[s] || '';
    li.hidden = s === 'skipped';
  }
}

function renderPrices(entry) {
  const jp = japanPrice(entry);
  $('#jpRm').textContent = rm(jp.rm);
  $('#jpNote').textContent = jp.note;
  if (document.activeElement !== $('#yenInput')) $('#yenInput').value = toNum(entry.yen) ?? '';
  $('#taxInclToggle').checked = entry.taxIncluded !== false;
  $('#taxFreeToggle').checked = Boolean(entry.taxFree);

  for (const [key, valueSel, rangeSel] of [['my_new', '#myNew', '#myNewRange'], ['my_used', '#myUsed', '#myUsedRange']]) {
    const r = entry.ai?.[key];
    const lo = toNum(r?.low);
    const hi = toNum(r?.high);
    $(valueSel).textContent = entry.ai ? rm(rangeValue(r)) : '…';
    $(rangeSel).textContent = lo && hi && lo !== hi ? `${rm(lo)} to ${rm(hi)}` : (entry.ai && !rangeValue(r) ? 'None found' : '');
  }

  const v = verdictFor(entry);
  $('#verdict').hidden = !v;
  if (v) {
    $('#verdict').className = `verdict ${v.cls}`;
    $('#verdictLabel').textContent = v.label;
    $('#verdictDetail').textContent = v.detail;
  }
}

function renderListings(entry) {
  const listings = Array.isArray(entry.ai?.listings) ? entry.ai.listings : [];
  const groups = [['new', 'New'], ['used', 'Second-hand']].map(([cond, title]) => {
    const items = listings.filter((l) => (l.condition || '').toLowerCase().startsWith(cond === 'new' ? 'new' : 'use'));
    if (!items.length) return null;
    return el('div', { class: 'listing-group' },
      el('h3', {}, title),
      items.map((l) => {
        const href = safeUrl(l.url);
        const label = l.title || 'Listing';
        return el('div', { class: 'listing' },
          el('div', {},
            href ? el('a', { href, target: '_blank', rel: 'noopener' }, label) : el('span', { class: 'title' }, label),
            el('span', { class: 'where' }, l.platform || ''),
          ),
          el('span', { class: 'price' }, rm(toNum(l.price_rm))),
        );
      }),
    );
  }).filter(Boolean);

  const notes = [entry.ai?.notes, entry.ai?.confidence ? `Match confidence: ${entry.ai.confidence}.` : null].filter(Boolean).join(' ');
  $('#listingsPanel').hidden = !entry.ai || (!groups.length && !notes);
  $('#listings').replaceChildren(...groups);
  $('#aiNotes').textContent = notes;
}

function renderResult(entry) {
  current = entry;
  $('#resPhoto').src = entry.thumb;
  $('#resName').textContent = entry.ai?.product_name || entry.webGuess || (running.has(entry.id) ? 'Reading…' : 'Unidentified item');
  $('#resBrand').textContent = entry.ai?.brand || '';
  $('#resTime').textContent = dateFmt.format(entry.createdAt);

  renderSteps(entry);
  $('#resError').hidden = entry.errors.length === 0;
  $('#resError').textContent = entry.errors.join('\n');

  const visionDone = entry.status.vision !== 'active';
  $('#prices').hidden = !visionDone;
  $('#toggles').hidden = !visionDone;
  renderPrices(entry);

  const q = searchQuery(entry);
  $('#searchLinks').hidden = !q;
  $('#shopeeLink').href = `https://shopee.com.my/search?keyword=${encodeURIComponent(q)}`;
  $('#carousellLink').href = `https://www.carousell.com.my/search/${encodeURIComponent(q)}`;

  renderListings(entry);

  const showTranslation = Boolean(entry.ocrText);
  $('#translationPanel').hidden = !showTranslation;
  $('#translation').textContent = entry.translation || (entry.status.translate === 'active' ? 'Translating…' : entry.sourceLang === 'en' ? entry.ocrText : '');
  $('#original').textContent = entry.ocrText;

  $('#sourcesPanel').hidden = !entry.sources?.length;
  $('#sources').replaceChildren(...(entry.sources || []).map((s) =>
    el('li', {}, el('a', { href: safeUrl(s.url), target: '_blank', rel: 'noopener' }, s.title)),
  ));

  const isRunning = running.has(entry.id);
  $('#retryBtn').hidden = isRunning || entry.status.search === 'done';
  $('#deleteBtn').hidden = isRunning;
}

// ---------- routing ----------

function route() {
  const hash = location.hash || '#/';
  const scan = hash.match(/^#\/scan\/([\w-]+)/);
  if (scan) {
    const entry = findEntry(scan[1]);
    if (entry) {
      if (current?.id !== entry.id) currentImageB64 = null;
      renderResult(entry);
      show('resultView');
      return;
    }
  }
  if (hash.startsWith('#/history')) {
    renderHistory();
    show('historyView');
    return;
  }
  renderHome();
  show('homeView');
}

// ---------- settings ----------

function openSettings() {
  $('#apiKeyInput').value = settings.apiKey;
  $('#geminiKeyInput').value = store.get('geminiKey', '');
  $('#modelInput').value = store.get('model', '') || DEFAULT_MODEL;
  $('#defaultTaxFree').checked = settings.taxFree;
  $('#settingsDialog').showModal();
}

$('#settingsForm').addEventListener('submit', () => {
  store.set('apiKey', $('#apiKeyInput').value.trim());
  store.set('geminiKey', $('#geminiKeyInput').value.trim());
  const model = $('#modelInput').value.trim();
  store.set('model', model && model !== DEFAULT_MODEL ? model : '');
  store.set('taxFree', $('#defaultTaxFree').checked);
  route();
});

$('#clearHistoryBtn').addEventListener('click', () => {
  if (!confirm('Delete all saved scans?')) return;
  store.set('history', []);
  $('#settingsDialog').close();
  location.hash = '#/';
  route();
});

// ---------- events ----------

$('#settingsBtn').addEventListener('click', openSettings);
document.querySelectorAll('[data-open-settings]').forEach((b) => b.addEventListener('click', openSettings));
$('#homeBtn').addEventListener('click', () => { location.hash = '#/'; });
$('#historyBtn').addEventListener('click', () => { location.hash = '#/history'; });
$('#seeAllBtn').addEventListener('click', () => { location.hash = '#/history'; });

for (const id of ['#cameraInput', '#galleryInput']) {
  $(id).addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    startScan(file);
  });
}

function editCurrent(fn) {
  if (!current) return;
  fn(current);
  saveEntry(current);
  renderPrices(current);
}

$('#yenInput').addEventListener('input', (e) => editCurrent((entry) => {
  entry.yen = toNum(e.target.value);
  entry.yenEdited = true;
}));
$('#taxInclToggle').addEventListener('change', (e) => editCurrent((entry) => { entry.taxIncluded = e.target.checked; }));
$('#taxFreeToggle').addEventListener('change', (e) => editCurrent((entry) => { entry.taxFree = e.target.checked; }));

$('#retryBtn').addEventListener('click', retrySearch);
$('#deleteBtn').addEventListener('click', () => {
  if (!current || !confirm('Delete this scan?')) return;
  deleteEntry(current.id);
  current = null;
  location.hash = '#/history';
});

window.addEventListener('hashchange', route);

// ---------- boot ----------

route();
fetchRate().then(() => {
  renderRate();
  if (current && location.hash.startsWith('#/scan/')) renderPrices(current);
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
