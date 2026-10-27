// Kaimono Check: photo → Google Vision OCR → Google Translate → Gemini (with Google Search)
// for Shopee / Carousell Malaysia prices. Everything runs in the browser; the API key
// lives in localStorage on the user's device only.

// Bump together with version.json on every release so open copies of the app offer a reload.
const APP_VERSION = '2026.10.27-7';
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
  get secondHand() { return store.get('secondHand', false); },
  get saveLocation() { return store.get('saveLocation', true); },
  get scanKind() { return store.get('scanKind', 'item'); },
  get autoInfo() { return store.get('autoInfo', false); },
  get quick() { return store.get('quick', false); },
  get buzz() { return store.get('buzz', true); },
  get serverUrl() { return store.get('serverUrl', ''); },
  get ntfyTopic() { return store.get('ntfyTopic', ''); },
  get ntfyToken() { return store.get('ntfyToken', ''); },
};

// Full-size photos live in IndexedDB (localStorage is too small) so old scans can be re-read properly.
const imageDb = {
  open() {
    this.db ||= new Promise((resolve, reject) => {
      const req = indexedDB.open('kaimono', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('images');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.db;
  },
  async run(mode, fn) {
    try {
      const db = await this.open();
      return await new Promise((resolve, reject) => {
        const req = fn(db.transaction('images', mode).objectStore('images'));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } catch {
      return null;
    }
  },
  get(id) { return this.run('readonly', (s) => s.get(id)); },
  put(id, b64) { return this.run('readwrite', (s) => s.put(b64, id)); },
  del(id) { return this.run('readwrite', (s) => s.delete(id)); },
  clear() { return this.run('readwrite', (s) => s.clear()); },
  async prune(keepIds) {
    const keys = (await this.run('readonly', (s) => s.getAllKeys())) || [];
    await Promise.all(keys.filter((k) => !keepIds.has(k)).map((k) => this.del(k)));
  },
};

// ---------- trips ----------

function loadTrips() {
  const trips = store.get('trips', []);
  return Array.isArray(trips) ? trips : [];
}

function ensureTrips() {
  let trips = loadTrips();
  if (!trips.length) {
    // First run with trips: everything so far (and the old single budget) becomes the first trip.
    trips = [{ id: 'trip1', name: 'My trip', createdAt: Date.now(), budget: toNum(store.get('budget', null)) }];
    store.set('trips', trips);
  }
  if (!trips.some((t) => t.id === store.get('currentTrip'))) store.set('currentTrip', trips[0].id);
  return trips;
}

function currentTrip() {
  const trips = ensureTrips();
  return trips.find((t) => t.id === store.get('currentTrip')) || trips[0];
}

// Scans from before trips existed belong to the first trip.
function tripOf(entry) {
  return entry.tripId || ensureTrips()[0].id;
}

function saveTrip(trip) {
  store.set('trips', loadTrips().map((t) => (t.id === trip.id ? trip : t)));
}

function newTrip() {
  const month = new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric' }).format(new Date());
  const name = prompt('Name this trip', `Japan ${month}`);
  if (!name?.trim()) return;
  const trip = { id: uid(), name: name.trim(), createdAt: Date.now(), budget: null };
  store.set('trips', [...loadTrips(), trip]);
  store.set('currentTrip', trip.id);
}

function loadHistory() {
  const list = store.get('history', []);
  return Array.isArray(list) ? list : [];
}

function saveEntry(entry) {
  let list = loadHistory().filter((e) => e.id !== entry.id);
  list.unshift(entry);
  list.sort((a, b) => b.createdAt - a.createdAt);
  const before = list.length;
  list = list.slice(0, HISTORY_LIMIT);
  // On quota errors, drop the oldest scans until it fits.
  while (!store.set('history', list) && list.length > 1) list.pop();
  if (list.length < before) imageDb.prune(new Set(list.flatMap((e) => [e.id, e.imageId].filter(Boolean))));
}

function deleteEntry(id) {
  const entry = findEntry(id);
  store.set('history', loadHistory().filter((e) => e.id !== id));
  if (entry) dropImageIfUnused(entry);
}

// Shelf items share the shelf's photo, so only delete a photo nothing else still points at.
function dropImageIfUnused(entry) {
  const imgId = entry.imageId || entry.id;
  if (!loadHistory().some((e) => e.id === imgId || e.imageId === imgId)) imageDb.del(imgId);
}

// Stored copies, swapped for the live object of any scan still in flight.
function historyEntries() {
  return loadHistory().map((e) => running.get(e.id) || e);
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

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  rescan: 'M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5',
  heart: 'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z',
};

function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

function distanceKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

function fmtAway(km) {
  return km < 0.05 ? 'You are here' : `${fmtDistance(km)} away`;
}

function fmtDistance(km) {
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(km < 10 ? 1 : 0)} km`;
}

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

// ---------- location ----------

let herePos = null;

// maxAge 0 for scans: a reading from a minute ago could be the previous shop.
function getPosition({ timeout = 10000, maxAge = 0 } = {}) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy) }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout, maximumAge: maxAge },
    );
  });
}

// OpenStreetMap reverse lookup: free, no key. Gives the area and, when the pin lands on one, the shop's name.
async function reverseGeocode(lat, lng) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1&accept-language=en`);
    const d = await r.json();
    const a = d.address || {};
    const area = [...new Set([a.quarter || a.neighbourhood || a.suburb, a.city || a.town || a.city_district || a.village].filter(Boolean))];
    const poi = ['shop', 'amenity'].includes(d.category) && d.name ? d.name : null;
    return { area: area.join(', ') || null, poi };
  } catch {
    return { area: null, poi: null };
  }
}

async function locate(entry, update) {
  const pos = await getPosition();
  if (!pos) {
    entry.place = { ...(entry.place || {}), unavailable: !entry.place?.lat };
    update();
    return;
  }
  herePos = pos;
  entry.place = { ...(entry.place || {}), ...pos, unavailable: false, area: null, poi: null };
  update();
  Object.assign(entry.place, await reverseGeocode(pos.lat, pos.lng));
  update();
}

// Typed name wins, then the shop name Gemini read off the tag, then the map's guess.
function storeName(entry) {
  return entry.place?.name || entry.ai?.store_name || entry.shelfStore || entry.place?.poi || null;
}

function distanceFromHere(entry) {
  return herePos && entry.place?.lat ? distanceKm(herePos, entry.place) : null;
}

function productTokens(entry) {
  const text = (entry.ai?.search_query || entry.ai?.product_name || '').normalize('NFKC').toLowerCase();
  return new Set(text.split(/[^a-z0-9\u3040-\u30ff\u4e00-\u9fff]+/).filter((t) => t.length > 1));
}

// Words that mark a different, differently priced model in the same line ("BFG Pro" vs "BFG Pro Reloaded",
// "DualSense" vs "DualSense Edge"). Two names only match if they agree on every one of these.
const VARIANT_WORDS = ['reloaded', 'pro', 'lite', 'oled', 'slim', 'mini', 'max', 'plus', 'ultra', 'elite', 'edge', 'neo',
  'ii', 'iii', 'iv', 'mkii', 'mk2', 'mk3', 'v2', 'v3', 'v4', '2nd', '3rd', '4th', '5th', 'digital', 'limited', 'special', 'deluxe', 'se'];

function sameVariant(a, b) {
  return VARIANT_WORDS.every((w) => a.has(w) === b.has(w));
}

function sameProduct(a, b) {
  const ta = productTokens(a);
  const tb = productTokens(b);
  if (!ta.size || !tb.size || !sameVariant(ta, tb)) return false;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return shared / (ta.size + tb.size - shared) >= 0.6;
}

// ---------- Google APIs ----------

// Without a timeout a hung request leaves the scan spinning forever and blocks rescans.
async function googlePost(url, body, service, key = settings.apiKey, timeoutMs = 30000) {
  let res;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    res = await fetch(`${url}?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch {
    clearTimeout(timer);
    throw new Error(ctrl.signal.aborted
      ? `${service}: no answer after ${timeoutMs / 1000}s. Tap ↻ to try again.`
      : `${service}: network error. Check your connection.`);
  }
  clearTimeout(timer);
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

function buildPrompt({ ocrText, webGuess, secondHand, focus, override, quick }) {
  return `You are helping a Malaysian shopper standing in a shop in Japan decide whether to buy an item here or back home in Malaysia.

The attached photo shows a product, box, price tag or shelf label in a Japanese shop.
OCR text from the photo:
"""
${ocrText || '(none detected)'}
"""
Google's visual best guess for the photo: "${webGuess || 'none'}"
${focus ? `\nThe photo shows a whole shelf with several products. Evaluate ONLY this one: "${focus.name}"${focus.yen ? `, priced ${yen(focus.yen)}` : ''}. Ignore every other product in the photo.\n` : ''}${override ? `\nThe shopper has checked the box and confirmed the exact product is: "${override}". Treat that as certain and price that exact model.\n` : ''}${secondHand ? '\nThe shopper is in a second-hand shop (e.g. Hard Off, 2nd Street, Book Off, Sofmap used), so this is a used item. When searching Malaysia, prioritise second-hand listings in similar condition.\n' : ''}
${quick ? 'QUICK MODE: keep this fast. Only search Shopee and Carousell Malaysia. Skip CeX, Mercari, Yahoo Auctions and the Malaysia compatibility check, and return null or empty lists for cex_my, jp_used_yen and my_compat.\n' : ''}
Tasks:
1. Identify the exact product: brand, model, size or capacity, and above all the exact variant. Words like Reloaded, Pro, Lite, OLED, Slim, Edge, V2, Mk II, 2nd Gen, Digital Edition or a special edition usually mean a different product at a different price (e.g. "Victrix Pro BFG" and "Victrix Pro BFG Reloaded" are different controllers). Read these words from the box, tag or the product itself and say where you saw them. If the photo doesn't show enough to tell lookalike variants apart, say so and list them with how to tell them apart.
2. Read the Japanese shop price in yen from the photo or OCR text. If both tax-inclusive (税込) and tax-exclusive (税抜) prices are shown, use the tax-inclusive one. Say whether the number you picked includes Japan's 10% consumption tax. Use null if no price is visible.
3. Use Google Search to find current prices in Malaysia, in RM, for the same product:
   - New: Shopee Malaysia (shopee.com.my). If Shopee has none, use Lazada Malaysia or official Malaysian retailers.
   - Second-hand: Carousell Malaysia (carousell.com.my), plus used listings on Shopee Malaysia.
   Only use Malaysian listings priced in RM. Exclude accessories, cases, spare parts and listings for a lookalike variant: they are a different product, even if most of the name matches. Never invent listings, prices or URLs; if you cannot find any, use null or an empty list.
   Also check CeX Malaysia (my.webuy.com), which sells graded used stock: search my.webuy.com for the exact model. Its product pages show "WeSell for" (its selling price), "WeBuy for cash" and "WeBuy for voucher" prices in RM.
   Also search Japan's second-hand market for the same item in comparable condition: Mercari Japan (jp.mercari.com) and Yahoo! Auctions Japan (auctions.yahoo.co.jp), prices in yen.
4. Read any condition information on the tag or label: the shop's condition grade or rank and what it means on that shop's scale (second-hand chains such as 2nd Street, Hard Off, Book Off, Geo, Sofmap and Surugaya each have their own scale; explain it plainly rather than just saying "good"). If the tag or shelf shows more than one grade (for example separate A and B units of the same item at different prices, or a printed grade legend), list every grade with its price and meaning, and say which one applies to the item photographed if you can tell. Also read every issue, defect or caveat mentioned (e.g. ジャンク, 動作未確認, 通電のみ, 欠品, キズ, 箱なし, 返品不可, 保証なし). Translate each into plain English and rate it: "high" = may not work, sold as-is, no returns or no warranty; "medium" = missing parts, visible damage or heavy wear; "low" = minor cosmetic. List stated positives (e.g. 動作確認済, 美品, 付属品完備) with severity "good". Ignore marketing claims on new-product packaging (e.g. 傷つきにくい means scratch-resistant, not scratched).
5. Check whether it will work properly in Malaysia: 240V 50Hz mains and Type G three-pin plugs (Japan is 100V with Type A two-pin plugs). Cover only what applies to this product:
   - Power: does it accept 240V? Many chargers and adapters are 100-240V and only need a plug adapter; 100V-only appliances (rice cookers, hair dryers, some kitchen and beauty gear) need a step-down transformer.
   - Region: game, Blu-ray or DVD region locks, region-specific online services or apps.
   - Language: Japanese-only menus, firmware or software.
   - Warranty: Japan-only domestic warranty (国内専用, 国内保証) versus international warranty honoured in Malaysia.
   - Other: e.g. forced camera shutter sound on Japanese phones, carrier locks, radio frequency bands, items restricted from import into Malaysia.
   Rate each "ok", "warn" or "bad". Use an empty list when none of this applies (clothes, snacks, books).

Reply with only a JSON object inside a \`\`\`json code block, with exactly these keys:
{
  "product_name": "concise English product name",
  "brand": "brand or null",
  "store_name": "shop or chain name if visible in the photo (e.g. HARD OFF, Bic Camera, Don Quijote), else null",
  "search_query": "best English query to type into Shopee or Carousell: brand + model + variant words",
  "variant": "the exact variant, edition or generation (e.g. Reloaded, OLED, 2nd Gen), or null if there is none",
  "variant_evidence": "where you saw it, e.g. 'box says Reloaded', or null",
  "variant_confidence": "high | medium | low",
  "lookalikes": [
    { "name": "full name of an easily confused variant", "how_to_tell": "how to tell them apart on the box or product", "typical_price_rm": 0 }
  ],
  "search_query_ja": "best Japanese query for Mercari or Yahoo Auctions",
  "jp_price_yen": 12800,
  "jp_price_tax_included": true,
  "jp_price_note": "short note on which price was read, or null",
  "my_new": { "low": 0, "high": 0, "typical": 0 },
  "my_used": { "low": 0, "high": 0, "typical": 0 },
  "jp_used_yen": { "low": 0, "high": 0, "typical": 0 },
  "cex_my": { "sell_rm": 0, "buy_cash_rm": 0, "buy_voucher_rm": 0, "grade": "CeX grade if shown (A, B, C) or null", "url": "CeX product URL or null" },
  "listings": [
    { "platform": "Shopee | Carousell | Lazada | Mercari JP | Yahoo Auctions | Other", "condition": "new | used", "title": "listing title", "price_rm": 0, "price_yen": 0, "url": "listing URL or null" }
  ],
  "my_compat": [
    { "topic": "Power | Region | Language | Warranty | Other", "status": "ok | warn | bad", "note": "short plain-English explanation" }
  ],
  "condition": {
    "is_used": "true if the tag or item shows it is second-hand (中古, a condition grade, ジャンク), otherwise false",
    "grade": "grade or rank exactly as shown for this item (e.g. B, ランクA, ジャンク), or null",
    "grade_meaning": "what that grade means on this shop's scale, in plain English, or null",
    "grade_options": [
      { "grade": "A", "price_yen": 0, "meaning": "plain-English meaning" }
    ],
    "issues": [
      { "jp": "original Japanese wording", "en": "plain English meaning", "severity": "high | medium | low | good" }
    ],
    "missing": ["items stated as missing, in English"]
  },
  "confidence": "high | medium | low",
  "notes": "one or two sentences on matching caveats (Japan-only variant, voltage, region lock, etc.)"
}
Use price_rm for Malaysian listings and price_yen for Japanese ones. Use null for any price you could not find. Use an empty issues list if the tag mentions no condition information, an empty grade_options list unless more than one grade is shown, and an empty lookalikes list when nothing is easily confused with it.`;
}

function parseJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('Gemini: answer was not in the expected format. Try again.');
  return JSON.parse(body.slice(start, end + 1));
}

async function askGemini({ imageB64, ocrText, webGuess, secondHand, focus, override, quick }) {
  const { json, sources } = await callGemini(imageB64, buildPrompt({ ocrText, webGuess, secondHand, focus, override, quick }));
  return { ai: json, sources };
}

async function callGemini(imageB64, prompt, { search = true, raw = false } = {}) {
  const parts = [];
  if (imageB64) parts.push({ inline_data: { mime_type: 'image/jpeg', data: imageB64 } });
  parts.push({ text: prompt });
  const body = { contents: [{ role: 'user', parts }] };
  if (search) body.tools = [{ google_search: {} }];
  const data = await googlePost(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(settings.model)}:generateContent`,
    body,
    'Gemini',
    settings.geminiKey,
    search ? 90000 : 60000, // grounded search regularly takes 20-40s
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
  return raw ? { text, sources } : { json: parseJson(text), sources };
}

// ---------- CeX Malaysia ----------
// CeX's own site search (an Algolia index behind search.webuy.io). Google rarely indexes CeX prices
// because its pages render them with JavaScript, so asking CeX directly is far more reliable.
// It's unofficial and may be region-locked, so Gemini's web search stays as the fallback.
const CEX_SEARCH = 'https://search.webuy.io/1/indexes/*/queries';
const CEX_INDEX = 'prod_cex_my';

function words(text) {
  return new Set((text || '').normalize('NFKC').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1));
}

const ACCESSORY_WORDS = ['case', 'cover', 'cable', 'charger', 'adapter', 'adaptor', 'stand', 'skin', 'strap', 'protector',
  'pouch', 'bag', 'sleeve', 'dock', 'mount', 'holder', 'grip', 'grips', 'pads', 'earpads', 'cushions', 'replacement', 'spare',
  'tempered', 'glass', 'film', 'sticker', 'decal', 'manual', 'box', 'lanyard', 'hood', 'cap', 'filter'];

// CeX search is fuzzy (cases and cables come back for headphones), so keep only rows naming the same
// model: most of the query's words, every word with a digit in it (XM5 is not XM6), and no
// accessory words the query didn't ask for.
function pickCex(query, hits) {
  const want = words(query);
  const modelWords = [...want].filter((t) => /\d/.test(t));
  let matches = hits.filter((h) => {
    if (!h?.boxName || !(toNum(h.sellPrice) > 0)) return false;
    const have = words(h.boxName);
    const shared = [...want].filter((t) => have.has(t)).length;
    return want.size && shared / want.size >= 0.6
      && modelWords.every((t) => have.has(t))
      && sameVariant(want, have)
      && !ACCESSORY_WORDS.some((w) => have.has(w) && !want.has(w));
  });
  // Anything priced under a quarter of the typical match is almost certainly a part, not the product.
  const prices = matches.map((h) => toNum(h.sellPrice)).sort((a, b) => a - b);
  const median = prices[Math.floor(prices.length / 2)];
  matches = matches.filter((h) => toNum(h.sellPrice) >= median * 0.25);
  if (!matches.length) return { found: false };
  const cheapest = matches.reduce((a, b) => (toNum(b.sellPrice) < toNum(a.sellPrice) ? b : a));
  // A cash/voucher price of 0 means CeX won't buy it; take the best offer across grades.
  const best = (key) => Math.max(0, ...matches.map((h) => toNum(h[key]) || 0)) || null;
  return {
    found: true,
    sell: toNum(cheapest.sellPrice),
    cash: best('cashPriceCalculated'),
    voucher: best('exchangePriceCalculated'),
    grade: (cheapest.boxName.match(/,\s*([A-C])\s*$/) || [])[1] || null,
    name: cheapest.boxName,
    url: cheapest.boxId ? `https://my.webuy.com/product-detail?id=${encodeURIComponent(cheapest.boxId)}` : null,
  };
}

async function cexLookup(query) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  const params = new URLSearchParams({ query, hitsPerPage: '30', filters: 'boxVisibilityOnWeb=1' }).toString();
  try {
    const res = await fetch(CEX_SEARCH, {
      method: 'POST',
      // A "simple" content type avoids a CORS preflight, as Algolia's own browser client does.
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: JSON.stringify({ requests: [{ indexName: CEX_INDEX, params }] }),
      signal: ctrl.signal,
    });
    if (!res.ok) return { found: false, error: res.status === 403 ? 'blocked by CeX (403)' : `HTTP ${res.status}` };
    const data = await res.json();
    return pickCex(query, data.results?.[0]?.hits || []);
  } catch {
    return { found: false, error: ctrl.signal.aborted ? 'timed out' : "couldn't reach CeX" };
  } finally {
    clearTimeout(timer);
  }
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

// ---------- condition (second-hand tags) ----------

// Common wording on Japanese second-hand tags (Hard Off, 2nd Street, Book Off, Sofmap…).
// Gives an instant read before Gemini answers, and a fallback if it fails.
const TAG_TERMS = [
  [['ジャンク'], 'high', 'Junk: sold as-is, may not work, no returns'],
  [['動作未確認', '動作確認なし', '未チェック'], 'high', 'Untested: not confirmed working'],
  [['通電のみ', '通電確認のみ'], 'high', 'Only checked that it powers on'],
  [['動作不良', '不具合', '故障'], 'high', 'Faulty or broken'],
  [['動作不可', '起動不可', '電源入らず', '電源が入らない', '不動'], 'high', "Doesn't work or won't power on"],
  [['現状品', '現状渡し', '現状販売', 'ノークレーム'], 'high', 'Sold as-is'],
  [['返品不可', '返品・交換不可', '返品交換不可'], 'high', 'No returns'],
  [['保証なし', '保証無し', '保証対象外'], 'high', 'No warranty'],
  [['水没'], 'high', 'Water damage'],
  [['部品取り'], 'high', 'For parts only'],
  [['画面割れ', '液晶割れ'], 'high', 'Cracked screen'],
  [['アクティベーションロック'], 'high', 'Activation lock: may be unusable'],
  [['ネットワーク利用制限', '利用制限'], 'medium', 'Network restriction status listed: make sure it shows ○'],
  [['付属品なし', '付属品無し', '欠品'], 'medium', 'Missing parts or accessories'],
  [['元箱なし', '外箱なし', '箱なし', '箱無し'], 'medium', 'No box'],
  [['説明書なし', '取説なし'], 'medium', 'No manual'],
  [['ACアダプターなし', 'アダプターなし', '充電器なし', 'ケーブルなし'], 'medium', 'No charger or cable'],
  [['展示品'], 'medium', 'Ex-display unit'],
  [['難あり', '訳あり', '訳アリ'], 'medium', 'Flagged as having a flaw'],
  [['使用感'], 'medium', 'Visible wear'],
  [['焼き付き', '画面焼け'], 'medium', 'Screen burn-in'],
  [['ドット抜け'], 'medium', 'Dead pixels'],
  [['バッテリー劣化', 'バッテリー消耗'], 'medium', 'Worn battery'],
  [['日焼け', '黄ばみ', '変色'], 'medium', 'Discolouration or yellowing'],
  [['異音'], 'medium', 'Makes unusual noises'],
  [['社外品', '非純正'], 'medium', 'Non-genuine parts'],
  [['書き込み', '線引き'], 'medium', 'Writing or underlining inside'],
  [['キズ', '傷', 'スレ'], 'low', 'Scratches or scuffs'],
  [['汚れ', 'シミ'], 'low', 'Dirt or stains'],
  [['凹み', 'へこみ', 'ヘコミ'], 'low', 'Dents'],
  [['割れ', '欠け', 'ヒビ'], 'medium', 'Cracks or chips'],
  [['動作確認済', '動作品', '動作OK'], 'good', 'Tested working'],
  [['付属品完備', '付属品完品'], 'good', 'All accessories included'],
  [['新品同様'], 'good', 'Like new'],
  [['未使用'], 'good', 'Unused'],
  [['開封品', '開封済'], 'good', 'Opened box, otherwise new'],
  [['美品'], 'good', 'Good condition'],
];

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2, good: 3 };

function detectIssues(text) {
  if (!text) return [];
  const found = [];
  const taken = [];
  const terms = TAG_TERMS.flatMap(([words, severity, en]) => words.map((jp) => ({ jp, severity, en })))
    .sort((a, b) => b.jp.length - a.jp.length);
  for (const t of terms) {
    let i = text.indexOf(t.jp);
    while (i !== -1) {
      const end = i + t.jp.length;
      if (!taken.some(([a, b]) => i < b && end > a)) {
        taken.push([i, end]);
        // "傷なし" / "欠品無し" etc. mean the problem is absent.
        const negated = t.severity !== 'high' && t.severity !== 'good' && !t.jp.endsWith('なし')
          && /^(な[しい]|無し?|ナシ)/.test(text.slice(end));
        const hit = negated
          ? { jp: text.slice(i, end + 2), severity: 'good', en: `No ${t.en.charAt(0).toLowerCase()}${t.en.slice(1)}` }
          : { jp: t.jp, severity: t.severity, en: t.en };
        if (!found.some((f) => f.en === hit.en)) found.push(hit);
      }
      i = text.indexOf(t.jp, end);
    }
  }
  return found.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

function detectGrade(text) {
  const m = (text || '').normalize('NFKC').match(/(?:ランク|RANK|状態|中古)\s*[:：]?\s*([SABCD][+-]?)(?![A-Za-z])/i);
  return m ? m[1].toUpperCase() : null;
}

const GRADE_MEANINGS = {
  S: 'Unused or like new',
  A: 'Very good, light signs of use',
  B: 'Used, some visible wear',
  C: 'Heavy wear or noticeable flaws',
  D: 'Significant damage or problems',
};

// Gemini's read wins once it arrives; the keyword check covers the wait and failures.
function conditionFor(entry) {
  const c = entry.ai?.condition;
  if (c && Array.isArray(c.issues)) {
    const issues = c.issues
      .filter((i) => i && (i.en || i.jp))
      .map((i) => ({ jp: i.jp || '', en: i.en || i.jp, severity: SEVERITY_ORDER[i.severity] !== undefined ? i.severity : 'medium' }))
      .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
    const gradeOptions = (Array.isArray(c.grade_options) ? c.grade_options : []).filter((o) => o && o.grade);
    // The shopper's pick from a multi-grade tag overrides Gemini's guess.
    const picked = entry.gradePicked && gradeOptions.find((o) => o.grade === entry.gradePicked);
    return {
      source: 'ai',
      grade: picked?.grade || c.grade || null,
      gradeMeaning: picked?.meaning || c.grade_meaning || null,
      gradeOptions,
      issues,
      missing: Array.isArray(c.missing) ? c.missing : [],
    };
  }
  if (!entry.secondHand) return null;
  const grade = detectGrade(entry.ocrText);
  return {
    source: 'local',
    grade,
    gradeMeaning: grade ? `${GRADE_MEANINGS[grade[0]] || ''} (typical scale; shops vary)` : null,
    issues: detectIssues(entry.ocrText),
    missing: [],
    gradeOptions: [],
  };
}

function seriousIssues(entry) {
  return (conditionFor(entry)?.issues || []).filter((i) => i.severity === 'high');
}

// ---------- Malaysia compatibility ----------

const COMPAT_ORDER = { bad: 0, warn: 1, ok: 2 };

function compatFor(entry) {
  const list = Array.isArray(entry.ai?.my_compat) ? entry.ai.my_compat : [];
  return list
    .filter((c) => c && (c.note || c.topic))
    .map((c) => ({ topic: c.topic || 'Other', status: COMPAT_ORDER[c.status] !== undefined ? c.status : 'warn', note: c.note || '' }))
    .sort((a, b) => COMPAT_ORDER[a.status] - COMPAT_ORDER[b.status]);
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

function fx(entry) {
  return rate?.value || entry.rate || null;
}

// Typical used price on Mercari / Yahoo Auctions, in yen.
function jpUsedYen(entry) {
  return rangeValue(entry.ai?.jp_used_yen);
}

// Live CeX search wins; Gemini's web-search read of CeX is the fallback.
function cexFor(entry) {
  const live = entry.cex;
  if (live?.found) return { ...live, source: 'live' };
  const c = entry.ai?.cex_my || {};
  const sell = toNum(c.sell_rm);
  return {
    sell,
    cash: toNum(c.buy_cash_rm),
    voucher: toNum(c.buy_voucher_rm),
    grade: c.grade || null,
    url: safeUrl(c.url)?.includes('webuy.com') ? c.url : null,
    source: sell ? 'web' : null,
    error: live?.error || null,
  };
}

function verdictFor(entry) {
  const v = baseVerdict(entry);
  if (!v || v.cls === 'none') return v;
  const bad = compatFor(entry).filter((c) => c.status === 'bad');
  if (bad.length) {
    if (v.cls === 'buy') Object.assign(v, { cls: 'maybe', label: 'Cheap, but check it works in Malaysia' });
    v.detail += ` Malaysia: ${bad.map((c) => c.topic.toLowerCase()).join(', ')} problem.`;
  }
  const jp = japanPrice(entry).rm;
  const resale = jpUsedYen(entry);
  if (resale && fx(entry) && jp && resale * fx(entry) < jp * 0.85) {
    v.detail += ` Mercari/Yahoo Japan has it second-hand for about ${yen(resale)} (${rm(resale * fx(entry))}).`;
  }
  const cex = cexFor(entry);
  if (cex.sell && jp && cex.sell < jp) v.detail += ` CeX Malaysia sells it used for ${rm(cex.sell)}.`;
  if (cex.cash) v.detail += ` CeX would buy it back for ${rm(cex.cash)} cash.`;
  return v;
}

function baseVerdict(entry) {
  const jp = japanPrice(entry).rm;
  const myNew = rangeValue(entry.ai?.my_new);
  const myUsed = rangeValue(entry.ai?.my_used);
  if (!entry.ai) return null;
  if (!jp) return { cls: 'none', label: 'Need the yen price', detail: 'Type the price from the tag to get a verdict.' };
  if (!myNew && !myUsed) return { cls: 'none', label: 'No Malaysian prices found', detail: 'Check the Shopee and Carousell links below.' };
  return entry.secondHand ? usedVerdict(entry, jp, myNew, myUsed) : newVerdict(jp, myNew, myUsed);
}

const pct = (a, b) => Math.round((a / b) * 100);

function newVerdict(jp, myNew, myUsed) {
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

// Second-hand: compare like for like against Malaysian used prices, then let tag issues temper it.
function usedVerdict(entry, jp, myNew, myUsed) {
  let v;
  if (myUsed) {
    const save = myUsed - jp;
    if (jp <= myUsed * 0.9) v = { cls: 'buy', label: 'Buy it here', detail: `${rm(save)} cheaper than second-hand in Malaysia (${pct(save, myUsed)}% less).` };
    else if (save > 0) v = { cls: 'maybe', label: 'Marginal', detail: `Only ${rm(save)} cheaper than second-hand in Malaysia (${pct(save, myUsed)}% less).` };
    else v = { cls: 'skip', label: 'Skip it', detail: `${rm(-save)} cheaper second-hand in Malaysia.` };
    if (myNew && myNew <= jp) v = { cls: 'skip', label: 'Skip it', detail: `It's ${rm(jp - myNew)} cheaper brand new in Malaysia.` };
  } else {
    // No used listings to compare: a used item should be well under the new price to be worth it.
    const save = myNew - jp;
    if (jp <= myNew * 0.7) v = { cls: 'buy', label: 'Buy it here', detail: `${pct(save, myNew)}% under the new price in Malaysia (${rm(save)} less). No MY second-hand listings found.` };
    else if (save > 0) v = { cls: 'maybe', label: 'Marginal', detail: `Only ${pct(save, myNew)}% under the new price in Malaysia. No MY second-hand listings found.` };
    else v = { cls: 'skip', label: 'Skip it', detail: `It's ${rm(-save)} cheaper brand new in Malaysia.` };
  }
  const serious = seriousIssues(entry);
  if (serious.length) {
    const flags = serious.map((i) => i.en.split(':')[0]).join(', ');
    if (v.cls === 'buy') v = { cls: 'maybe', label: 'Cheap, but read the issues', detail: v.detail };
    v.detail += ` Tag says: ${flags}.`;
  }
  return v;
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
  if (settings.scanKind === 'shelf') {
    await startShelf(file);
    return;
  }

  let full;
  let thumb;
  try {
    const src = await decodeImage(file);
    full = toJpeg(src, 1400, 0.8); // small enough to upload in a second or two, sharp enough for tag text
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
    secondHand: settings.secondHand,
    quick: settings.quick,
    tripId: currentTrip().id,
    place: null,
    rate: rate?.value || null,
    status: { vision: 'pending', translate: 'pending', search: 'pending' },
    errors: [],
  };
  current = entry;
  currentImageB64 = full.split(',')[1];
  imageDb.put(entry.id, currentImageB64);
  running.set(entry.id, entry);
  saveEntry(entry);
  location.hash = `#/scan/${entry.id}`;

  // Location is only taken at the moment of scanning; a later rescan keeps the original store.
  if (settings.saveLocation) locate(entry, () => refresh(entry));
  await runScan(entry, currentImageB64);
}

// Re-run a saved scan from its stored photo: redoes any failed step and refreshes the prices.
async function rescan(id, { quiet = false } = {}) {
  if (running.has(id)) return;
  const entry = findEntry(id);
  if (!entry) return;
  if (!settings.apiKey) {
    openSettings();
    return;
  }
  const image = (current?.id === id && currentImageB64) || (await imageDb.get(entry.imageId || id)) || entry.thumb.split(',')[1];
  await runScan(entry, image, { quiet });
}

function refresh(entry) {
  saveEntry(entry);
  const hash = location.hash || '#/';
  if (hash === `#/scan/${entry.id}`) renderResult(entry);
  else if (!hash.startsWith('#/scan/')) route(true);
}

async function runScan(entry, imageB64, { quiet = false } = {}) {
  if (settings.serverUrl) {
    await runScanOnServer(entry, imageB64, { quiet });
    return;
  }
  running.set(entry.id, entry);
  entry.errors = [];
  const startedAt = Date.now();
  const update = () => refresh(entry);

  if (entry.status.vision !== 'done') {
    entry.status.vision = 'active';
    update();
    try {
      Object.assign(entry, await readImage(imageB64));
      entry.status.vision = 'done';
    } catch (e) {
      entry.status.vision = 'failed';
      entry.errors.push(e.message);
    }
  }
  if (!entry.yen) entry.yen = parseYen(entry.ocrText);
  if (!entry.ocrText) entry.status.translate = 'skipped';
  else if (entry.status.translate !== 'done') entry.status.translate = 'active';
  update();

  const translating = entry.status.translate === 'active'
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

  await Promise.all([translating, searchPrices(entry, imageB64, update)]);
  if (!entry.rate && rate) entry.rate = rate.value;
  // Left the app mid-scan and the connection was cut: pick it up again when the app is back.
  if (lastHiddenAt > startedAt && entry.errors.some((m) => /network error|no answer after/.test(m))) entry.resume = true;
  running.delete(entry.id);
  update();
  if (!quiet) notifyDone();
}

// ---------- "it's ready" buzz ----------
// Android vibrates. iPhone web apps can't call vibration, so play a short chime and, on iOS 18+,
// toggle a hidden native switch, which gives a haptic tick. Audio has to be unlocked by a tap first.

let audioCtx = null;

function unlockAudio() {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state !== 'running') audioCtx.resume();
  } catch {
    // no Web Audio: vibration/haptic only
  }
}

function chime() {
  if (!audioCtx) return;
  audioCtx.resume?.();
  const t = audioCtx.currentTime;
  [880, 1318.5].forEach((freq, i) => {
    const start = t + i * 0.13;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.22, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.28);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(start);
    osc.stop(start + 0.3);
  });
}

let hapticLabel = null;

function notifyDone() {
  if (!settings.buzz) return;
  if (navigator.vibrate) {
    navigator.vibrate([70, 50, 70]);
  } else {
    try {
      if (!hapticLabel) {
        hapticLabel = el('label', { 'aria-hidden': 'true', style: 'position:fixed;opacity:0;pointer-events:none' },
          el('input', { type: 'checkbox', switch: true, tabindex: '-1' }));
        document.body.append(hapticLabel);
      }
      hapticLabel.click();
    } catch {
      // no haptics available
    }
  }
  chime();
}

async function searchPrices(entry, imageB64, update) {
  entry.status.search = 'active';
  entry.errors = entry.errors.filter((m) => !m.startsWith('Gemini'));
  update();
  try {
    const { ai, sources } = await askGemini({
      imageB64,
      ocrText: entry.ocrText || entry.contextText,
      webGuess: entry.webGuess,
      secondHand: entry.secondHand,
      focus: entry.focus,
      override: entry.override,
      quick: entry.quick,
    });
    applyAi(entry, ai, sources);
  } catch (e) {
    entry.status.search = 'failed';
    entry.errors.push(e.message);
  }
  update();

  if (entry.ai && settings.autoInfo && !entry.info) loadInfo(entry.id);
  await lookupCex(entry, update);
}

function applyAi(entry, ai, sources) {
  entry.ai = ai;
  entry.sources = sources;
  // A graded or 中古 tag means a used item even if the app was in New mode; compare it like for like.
  if (ai.condition?.is_used === true && !entry.secondHand && !entry.secondHandEdited) {
    entry.secondHand = true;
    entry.autoUsed = true;
  }
  if (!entry.yenEdited) {
    entry.yen = toNum(ai.jp_price_yen) || entry.yen || parseYen(entry.ocrText);
    if (typeof ai.jp_price_tax_included === 'boolean') entry.taxIncluded = ai.jp_price_tax_included;
  }
  entry.status.search = 'done';
}

async function lookupCex(entry, update) {
  const query = entry.ai?.search_query || entry.ai?.product_name;
  if (!query) return;
  entry.cexPending = true;
  update();
  entry.cex = { ...(await cexLookup(query)), checkedAt: Date.now() };
  entry.cexPending = false;
  update();
}

// ---------- background scanning (optional Apps Script server) ----------
// Phones suspend a web app's network calls as soon as you leave it. With a scan server set up,
// the scan runs there instead; the app collects the result whenever it's next open, and the
// server pings the phone through ntfy.

const pendingPolls = new Set();
let pollTimer = null;

function serverSecret() {
  let secret = store.get('serverSecret', '');
  if (!secret) {
    secret = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    store.set('serverSecret', secret);
  }
  return secret;
}

async function serverCall(body, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // No custom headers: a plain text POST skips the CORS preflight that Apps Script can't answer.
    const res = await fetch(settings.serverUrl, { method: 'POST', body: JSON.stringify({ ...body, secret: serverSecret() }), signal: ctrl.signal });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      // Apps Script answers with an HTML page when the deployment isn't public or the script crashed.
      const hint = /permission|authori[sz]/i.test(text) ? 'it needs authorising (run "authorise" in the editor)' : 'check Who has access is "Anyone" and that you deployed the latest version';
      throw new Error(`Scan server: sent back a web page instead of a reply; ${hint}.`);
    }
    if (data.error) throw new Error(`Scan server: ${data.error}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function notifyTarget() {
  return settings.ntfyTopic ? { topic: settings.ntfyTopic, token: settings.ntfyToken || undefined } : null;
}

function describeNtfy(r) {
  if (!r) return 'no answer';
  if (r.code >= 200 && r.code < 300) return r.tries > 1 ? `sent ✓ (after ${r.tries} tries)` : 'sent ✓';
  if (r.code === 0 && /address unavailable/i.test(r.body || '')) return `failed after ${r.tries || 1} tries: Google couldn't connect to ntfy.sh. Usually temporary.`;
  if (r.code === 429) return 'ntfy refused it: too many requests from Google\'s shared servers. Add an ntfy access token below.';
  if (r.code === 401 || r.code === 403) return `ntfy refused it (${r.code}): check the access token, or that the topic isn't reserved by someone else.`;
  return `failed (${r.code || 'error'}): ${r.body || ''}`.trim();
}

function serverJobRequest(entry, imageB64) {
  const visionDone = entry.status.vision === 'done';
  return {
    action: 'scan',
    jobId: entry.serverJob.id,
    image: imageB64,
    keys: { cloud: settings.apiKey, gemini: settings.geminiKey },
    model: settings.model,
    referer: `${location.origin}${location.pathname}`,
    vision: !visionDone,
    ocrText: visionDone ? entry.ocrText || entry.contextText || '' : '',
    webGuess: visionDone ? entry.webGuess || '' : '',
    translate: !['done', 'skipped'].includes(entry.status.translate),
    // The server swaps in the OCR text and Vision's guess once it has them.
    prompt: buildPrompt({
      ocrText: visionDone ? entry.ocrText || entry.contextText : '{{OCR}}',
      webGuess: visionDone ? entry.webGuess : '{{WEBGUESS}}',
      secondHand: entry.secondHand,
      focus: entry.focus,
      override: entry.override,
      quick: entry.quick,
    }),
    cex: { index: CEX_INDEX },
    notify: notifyTarget(),
  };
}

async function runScanOnServer(entry, imageB64, { quiet = false } = {}) {
  running.set(entry.id, entry);
  entry.errors = [];
  entry.serverJob = { id: uid(), sentAt: Date.now(), done: false };
  if (entry.status.vision !== 'done') entry.status.vision = 'active';
  if (!['done', 'skipped'].includes(entry.status.translate)) entry.status.translate = 'active';
  entry.status.search = 'active';
  refresh(entry);
  const jobId = entry.serverJob.id;
  const stopAck = watchForReceipt(entry, jobId);
  let out = null;
  try {
    out = await serverCall(serverJobRequest(entry, imageB64), 330000);
  } catch {
    // The app was closed or lost signal mid-request. If the upload got through, the server carries
    // on; if not, the scan is re-sent when the app is back.
    if (entry.serverJob?.id === jobId) entry.serverJob = { ...entry.serverJob, requestFailed: true };
    saveEntry(entry);
  }
  stopAck();
  if (out?.status === 'done') await applyServerResult(entry, out, { quiet });
  else pollServerJobs();
}

// While the photo uploads, ask the server whether it has started the job, so the app can say
// when it's safe to close. The server marks a job "running" the moment it arrives.
function watchForReceipt(entry, jobId) {
  let stopped = false;
  const check = async () => {
    if (stopped || entry.serverJob?.id !== jobId || entry.serverJob.received) return;
    try {
      const r = await serverCall({ action: 'result', jobId }, 8000);
      if (!stopped && (r.status === 'running' || r.status === 'done') && entry.serverJob?.id === jobId) {
        entry.serverJob = { ...entry.serverJob, received: true };
        refresh(entry);
        navigator.vibrate?.(30);
        return;
      }
    } catch {
      // try again shortly
    }
    if (!stopped) setTimeout(check, 1500);
  };
  setTimeout(check, 1200);
  return () => { stopped = true; };
}

async function applyServerResult(entry, out, { quiet = false } = {}) {
  if (entry.serverJob?.done) return; // already collected (the request and a poll can both come back)
  if (out.vision) {
    Object.assign(entry, out.vision);
    entry.status.vision = 'done';
  } else if (out.visionError) {
    entry.status.vision = 'failed';
    entry.errors.push(out.visionError);
  }
  if (!entry.yen) entry.yen = parseYen(entry.ocrText);
  if (out.translate) {
    Object.assign(entry, out.translate);
    entry.status.translate = 'done';
  } else if (out.translateError) {
    entry.status.translate = 'failed';
    entry.errors.push(out.translateError);
  } else if (entry.status.translate === 'active') {
    entry.status.translate = 'skipped';
  }
  if (out.gemini) {
    try {
      const sources = (out.gemini.chunks || []).filter((c) => safeUrl(c.uri)).map((c) => ({ title: c.title, url: c.uri }));
      applyAi(entry, parseJson(out.gemini.text), sources);
    } catch (e) {
      entry.status.search = 'failed';
      entry.errors.push(e.message);
    }
  } else {
    entry.status.search = 'failed';
    entry.errors.push(out.geminiError || 'Gemini: no result came back from the scan server.');
  }
  if (out.cex?.hits) entry.cex = { ...pickCex(out.cex.query, out.cex.hits), checkedAt: Date.now() };
  // Keep the server's timings and ntfy's answer so a missing notification can be explained.
  entry.serverJob = { ...entry.serverJob, done: true, startedAt: out.startedAt, finishedAt: out.finishedAt, ntfy: out.ntfy || null };
  if (!entry.rate && rate) entry.rate = rate.value;
  running.delete(entry.id);
  const update = () => refresh(entry);
  update();
  if (!quiet) notifyDone();
  if (entry.ai && settings.autoInfo && !entry.info) loadInfo(entry.id);
  // Google's servers sit outside Malaysia and CeX may refuse them, so try from the phone as well.
  if (entry.ai && !entry.cex?.found) await lookupCex(entry, update);
}

const clock = (t) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(t);

// One line on the result saying what the scan server did, to pin down missing notifications.
function serverReport(job) {
  if (!job?.done) return '';
  if (job.stalled) return `Scan server: started at ${clock(job.startedAt || job.sentAt)} and stopped before finishing, so no notification was sent.`;
  if (!job.finishedAt) return '';
  const took = job.startedAt ? ` (${Math.round((job.finishedAt - job.startedAt) / 1000)}s)` : '';
  const note = job.ntfy ? `notification ${describeNtfy(job.ntfy)}` : 'no notification topic set';
  return `Scan server: finished at ${clock(job.finishedAt)}${took} · ${note}`;
}

function giveUpServerJob(entry, message) {
  for (const k of Object.keys(entry.status)) if (entry.status[k] === 'active') entry.status[k] = 'failed';
  entry.errors.push(message);
  entry.serverJob = { ...entry.serverJob, done: true };
  running.delete(entry.id);
  refresh(entry);
}

function pendingServerEntries() {
  return historyEntries().filter((e) => e.serverJob && !e.serverJob.done);
}

async function checkServerJob(entry) {
  if (pendingPolls.has(entry.id)) return;
  pendingPolls.add(entry.id);
  try {
    const out = await serverCall({ action: 'result', jobId: entry.serverJob.id }, 15000);
    const age = Date.now() - entry.serverJob.sentAt;
    if (out.status === 'done') {
      await applyServerResult(entry, out);
    } else if (out.status === 'unknown' && (age > 20000 || entry.serverJob.requestFailed)) {
      // The upload never arrived (the app closed or lost signal while sending). Send it again.
      const resends = entry.serverJob.resends || 0;
      if (resends < 3) {
        const image = (await imageDb.get(entry.imageId || entry.id)) || entry.thumb.split(',')[1];
        const jobId = entry.serverJob.id;
        entry.serverJob = { ...entry.serverJob, resends: resends + 1, requestFailed: false, sentAt: Date.now() };
        saveEntry(entry);
        refresh(entry);
        const stopAck = watchForReceipt(entry, jobId);
        serverCall(serverJobRequest(entry, image), 330000)
          .then((res) => (res?.status === 'done' ? applyServerResult(entry, res) : null))
          .catch(() => {
            if (entry.serverJob?.id === jobId && !entry.serverJob.done) {
              entry.serverJob = { ...entry.serverJob, requestFailed: true };
              saveEntry(entry);
            }
          })
          .finally(stopAck);
      } else {
        giveUpServerJob(entry, "Scan server: the photo couldn't be sent. Check your signal and tap ↻ to try again.");
      }
    } else if (out.status === 'running') {
      if (out.startedAt && entry.serverJob.startedAt !== out.startedAt) {
        entry.serverJob = { ...entry.serverJob, startedAt: out.startedAt };
        saveEntry(entry);
      }
      // A scan normally takes under a minute; three minutes with no result means the server stopped.
      if (Date.now() - (out.startedAt || entry.serverJob.sentAt) > 3 * 60 * 1000) {
        entry.serverJob = { ...entry.serverJob, stalled: true };
        giveUpServerJob(entry, `Scan server: started the scan at ${clock(out.startedAt || entry.serverJob.sentAt)} but never finished it. Tap ↻ to try again.`);
      }
    }
  } catch {
    // offline or the server is busy: try again on the next tick
  } finally {
    pendingPolls.delete(entry.id);
  }
}

function pollServerJobs() {
  if (pollTimer || !settings.serverUrl) return;
  const tick = () => {
    if (document.visibilityState !== 'visible') return;
    const pending = pendingServerEntries();
    if (!pending.length) {
      clearInterval(pollTimer);
      pollTimer = null;
      return;
    }
    for (const e of pending) {
      const entry = running.get(e.id) || e;
      running.set(entry.id, entry);
      checkServerJob(entry);
    }
  };
  pollTimer = setInterval(tick, 4000);
  tick();
}

let lastHiddenAt = 0;

// Run on launch and whenever the app comes back on screen.
function resumeWork() {
  if (pendingServerEntries().length) {
    for (const e of pendingServerEntries()) if (!running.has(e.id)) running.set(e.id, e);
    pollServerJobs();
    route(true);
  }
  // Without a server, a scan cut off by leaving the app (or the app being closed) restarts by itself.
  const cutOff = historyEntries().filter((e) => !running.has(e.id) && e.kind !== 'shelf'
    && (e.resume || (Object.values(e.status).includes('active') && !(e.serverJob && !e.serverJob.done) && Date.now() - e.createdAt < 60 * 60 * 1000)));
  for (const e of cutOff) {
    e.resume = false;
    saveEntry(e);
    rescan(e.id);
  }
}

// ---------- whole-shelf scan ----------
// One photo → Vision OCR → Gemini lists every priced item (no search, so it's quick).
// Each item can then be price-checked as its own scan, sharing the shelf photo.

const shelfChecking = new Set();

function shelfPrompt(ocrText) {
  return `The attached photo shows a shelf, display case or rack in a Japanese shop with several products and price tags.
OCR text from the photo:
"""
${ocrText || '(none detected)'}
"""

List every distinct product that has a visible price tag. For each give:
- name: concise English product name (brand + model or variant)
- search_query: best English query for Shopee Malaysia
- jp_price_yen: the price in yen as shown; if both 税込 and 税抜 are shown, use 税込
- tax_included: whether that price includes Japan's 10% consumption tax
- box_2d: bounding box of the product together with its price tag, as [ymin, xmin, ymax, xmax] normalised to 0-1000
Skip items whose price you cannot read. Never guess prices.

Reply with only a JSON object inside a \`\`\`json code block:
{ "store_name": "shop or chain name if visible, else null", "items": [ { "name": "", "search_query": "", "jp_price_yen": 0, "tax_included": true, "box_2d": [0, 0, 0, 0] } ] }`;
}

async function startShelf(file) {
  let full;
  let thumb;
  try {
    const src = await decodeImage(file);
    full = toJpeg(src, 2048, 0.85); // tags on a shelf are small, so keep more pixels
    thumb = toJpeg(src, 320, 0.7);
    src.close?.();
  } catch {
    alert('Could not open that image. Try another photo.');
    return;
  }
  const shelf = {
    id: uid(),
    kind: 'shelf',
    createdAt: Date.now(),
    thumb,
    ocrText: '',
    items: [],
    shelfStore: null,
    taxFree: settings.taxFree,
    secondHand: settings.secondHand,
    tripId: currentTrip().id,
    place: null,
    rate: rate?.value || null,
    status: { vision: 'pending', list: 'pending' },
    errors: [],
  };
  const b64 = full.split(',')[1];
  imageDb.put(shelf.id, b64);
  running.set(shelf.id, shelf);
  saveEntry(shelf);
  location.hash = `#/shelf/${shelf.id}`;
  if (settings.saveLocation) locate(shelf, () => refresh(shelf));
  await runShelf(shelf, b64);
}

async function rescanShelf(id) {
  if (running.has(id)) return;
  const shelf = findEntry(id);
  if (!shelf) return;
  const b64 = (await imageDb.get(id)) || shelf.thumb.split(',')[1];
  await runShelf(shelf, b64);
}

async function runShelf(shelf, b64) {
  running.set(shelf.id, shelf);
  shelf.errors = [];
  const update = () => refresh(shelf);
  if (shelf.status.vision !== 'done') {
    shelf.status.vision = 'active';
    update();
    try {
      shelf.ocrText = (await readImage(b64)).ocrText;
      shelf.status.vision = 'done';
    } catch (e) {
      shelf.status.vision = 'failed';
      shelf.errors.push(e.message);
    }
  }
  shelf.status.list = 'active';
  update();
  try {
    const { json } = await callGemini(b64, shelfPrompt(shelf.ocrText), { search: false });
    const previous = new Map(shelf.items.map((i) => [i.name.toLowerCase(), i]));
    shelf.shelfStore = json.store_name || shelf.shelfStore;
    shelf.items = (Array.isArray(json.items) ? json.items : [])
      .filter((i) => i && i.name)
      .map((i) => ({
        key: uid(),
        name: String(i.name),
        query: i.search_query || i.name,
        yen: toNum(i.jp_price_yen),
        taxIncluded: i.tax_included !== false,
        box: Array.isArray(i.box_2d) ? i.box_2d.map(toNum) : null,
        childId: previous.get(String(i.name).toLowerCase())?.childId || null,
      }));
    await cropThumbs(b64, shelf.items);
    shelf.status.list = 'done';
  } catch (e) {
    shelf.status.list = 'failed';
    shelf.errors.push(e.message);
  }
  running.delete(shelf.id);
  update();
  notifyDone();
}

// Small per-item thumbnails cut from the shelf photo using Gemini's boxes.
async function cropThumbs(b64, items) {
  const img = new Image();
  img.src = `data:image/jpeg;base64,${b64}`;
  try {
    await img.decode();
  } catch {
    return;
  }
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  for (const it of items) {
    const b = it.box;
    if (!b || b.length !== 4 || !b.every(Number.isFinite)) continue;
    let [y0, x0, y1, x1] = b.map((n) => n / 1000);
    if (y1 <= y0 || x1 <= x0) continue;
    const padY = (y1 - y0) * 0.08;
    const padX = (x1 - x0) * 0.08;
    y0 = Math.max(0, y0 - padY);
    x0 = Math.max(0, x0 - padX);
    y1 = Math.min(1, y1 + padY);
    x1 = Math.min(1, x1 + padX);
    const sw = (x1 - x0) * W;
    const sh = (y1 - y0) * H;
    const scale = Math.min(1, 200 / Math.max(sw, sh));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sw * scale));
    canvas.height = Math.max(1, Math.round(sh * scale));
    canvas.getContext('2d').drawImage(img, x0 * W, y0 * H, sw, sh, 0, 0, canvas.width, canvas.height);
    it.thumb = canvas.toDataURL('image/jpeg', 0.7);
  }
}

// Price-check one shelf item as a normal scan focused on that product.
async function checkShelfItem(shelf, item, image, quiet = false) {
  if (item.childId && findEntry(item.childId)) {
    await rescan(item.childId, { quiet });
    return;
  }
  const child = {
    id: uid(),
    createdAt: Date.now(),
    thumb: item.thumb || shelf.thumb,
    imageId: shelf.id,
    parentId: shelf.id,
    focus: { name: item.name, yen: item.yen },
    ocrText: '',
    contextText: shelf.ocrText,
    webGuess: item.query,
    translation: '',
    sourceLang: '',
    ai: null,
    sources: [],
    yen: item.yen,
    taxIncluded: item.taxIncluded,
    taxFree: shelf.taxFree,
    secondHand: shelf.secondHand,
    quick: settings.quick,
    tripId: shelf.tripId,
    place: shelf.place ? { ...shelf.place } : null,
    shelfStore: shelf.shelfStore,
    rate: rate?.value || null,
    status: { vision: 'done', translate: 'skipped', search: 'pending' },
    errors: [],
  };
  // Save onto the latest stored shelf so parallel checks don't overwrite each other's links.
  item.childId = child.id;
  const latest = findEntry(shelf.id) || shelf;
  const stored = latest.items.find((i) => i.key === item.key);
  if (stored) stored.childId = child.id;
  saveEntry(latest);
  saveEntry(child);
  await runScan(child, image || (await imageDb.get(shelf.id)) || shelf.thumb.split(',')[1], { quiet });
}

async function checkAllShelf(id) {
  const shelf = findEntry(id);
  if (!shelf || shelfChecking.has(id)) return;
  if (!settings.apiKey) {
    openSettings();
    return;
  }
  shelfChecking.add(id);
  route(true);
  const image = (await imageDb.get(id)) || shelf.thumb.split(',')[1];
  const todo = shelf.items.filter((i) => {
    const child = i.childId && findEntry(i.childId);
    return !child || scanFailed(child);
  });
  let next = 0;
  // Two at a time: quicker than one-by-one without tripping Gemini's rate limits.
  const worker = async () => {
    while (next < todo.length) {
      const item = todo[next];
      next += 1;
      await checkShelfItem(shelf, item, image, true);
    }
  };
  await Promise.all([worker(), worker()]);
  shelfChecking.delete(id);
  route(true);
  notifyDone();
}

function shelfItemPrice(shelf, item) {
  const rateValue = rate?.value || shelf.rate;
  if (!item.yen || !rateValue) return null;
  return (item.taxIncluded === false ? item.yen * (1 + TAX) : item.yen) * rateValue;
}

function shelfHistoryItem(shelf) {
  const isRunning = running.has(shelf.id) || shelfChecking.has(shelf.id);
  const failed = scanFailed(shelf);
  const checked = shelf.items.filter((i) => i.childId).length;
  const meta = [`${shelf.items.length} item${shelf.items.length === 1 ? '' : 's'}`, checked ? `${checked} checked` : null, dateFmt.format(shelf.createdAt)]
    .filter(Boolean).join(' · ');
  const where = storeName(shelf) || shelf.place?.area;
  return swipeRow(shelf, el('div', { class: 'history-row' },
    el('button', { class: 'history-item', type: 'button', onclick: () => { location.hash = `#/shelf/${shelf.id}`; } },
      el('img', { src: shelf.thumb, alt: '' }),
      el('div', { class: 'history-body' },
        el('p', { class: 'history-name' }, `Shelf${where ? ` · ${where}` : ''}`),
        el('p', { class: 'history-meta' }, meta),
      ),
      el('span', { class: `tag ${failed ? 'tag-skip' : ''}` }, failed ? 'Failed' : isRunning ? '…' : 'Shelf'),
    ),
    rowActions(shelf, running.has(shelf.id), failed),
  ));
}

function renderShelf(shelf) {
  current = null;
  const isRunning = running.has(shelf.id);
  const checking = shelfChecking.has(shelf.id);
  const unchecked = shelf.items.filter((i) => !i.childId).length;

  const rows = shelf.items.map((item) => {
    const child = item.childId ? findEntry(item.childId) : null;
    const price = shelfItemPrice(shelf, item);
    let right;
    if (child && running.has(child.id)) {
      right = el('span', { class: 'rescan-btn spinning shelf-spin', 'aria-label': 'Checking' }, icon('rescan'));
    } else if (child) {
      const v = verdictFor(child);
      const failed = scanFailed(child);
      const cls = failed ? 'tag-skip' : { buy: 'tag-buy', maybe: 'tag-maybe', skip: 'tag-skip' }[v?.cls] || '';
      right = el('span', { class: `tag ${cls}` }, failed ? 'Failed' : { buy: 'Buy', maybe: 'Maybe', skip: 'Skip' }[v?.cls] || '–');
    } else {
      right = el('button', {
        class: 'btn btn-small',
        type: 'button',
        onclick: (e) => {
          e.stopPropagation();
          checkShelfItem(shelf, item);
        },
      }, 'Check');
    }
    const body = [
      el('img', { src: item.thumb || shelf.thumb, alt: '' }),
      el('div', { class: 'history-body' },
        el('p', { class: 'history-name' }, child?.ai?.product_name || item.name),
        el('p', { class: 'history-meta' }, [item.yen ? yen(item.yen) : 'No price read', price ? rm(price) : null].filter(Boolean).join(' · ')),
      ),
      right,
    ];
    return el('li', { class: 'history-row' }, child
      ? el('button', { class: 'history-item', type: 'button', onclick: () => { location.hash = `#/scan/${child.id}`; } }, body)
      : el('div', { class: 'history-item' }, body));
  });

  let status = '';
  if (isRunning) status = shelf.status.vision === 'active' ? 'Reading the price tags…' : 'Listing the items…';
  else if (shelf.status.list === 'done' && !shelf.items.length) status = 'No priced items found. Try a closer photo with the tags in focus.';

  $('#shelfView').replaceChildren(...[
    el('div', { class: 'result-top' },
      el('img', { class: 'result-photo zoomable', src: shelf.thumb, alt: 'Shelf photo, tap to zoom', onclick: () => openPhoto(shelf.id, shelf.thumb) }),
      el('div', { class: 'result-title' },
        el('p', { class: 'eyebrow' }, 'Whole shelf'),
        el('h1', {}, storeName(shelf) || `${shelf.items.length} item${shelf.items.length === 1 ? '' : 's'}`),
        el('p', { class: 'muted small' }, [shelf.place?.area, dateFmt.format(shelf.createdAt)].filter(Boolean).join(' · ')),
      ),
      el('button', {
        class: `rescan-btn${isRunning ? ' spinning' : ''}${scanFailed(shelf) ? ' attention' : ''}`,
        type: 'button',
        'aria-label': 'Re-read shelf',
        title: 'Re-read shelf',
        disabled: isRunning,
        onclick: () => rescanShelf(shelf.id),
      }, icon('rescan')),
    ),
    status ? el('p', { class: 'muted' }, status) : null,
    shelf.errors.length ? el('p', { class: 'error', role: 'alert' }, shelf.errors.join('\n')) : null,
    shelf.items.length ? el('button', {
      class: 'btn btn-primary btn-block',
      type: 'button',
      disabled: checking || isRunning || unchecked === 0,
      onclick: () => checkAllShelf(shelf.id),
    }, checking ? 'Checking prices…' : unchecked ? `Check all prices (${unchecked})` : 'All items checked') : null,
    el('ul', { class: 'history-list' }, rows),
    shelf.items.length ? el('p', { class: 'muted small' }, 'Each checked item becomes its own scan in History, with the full Malaysia comparison.') : null,
  ].filter(Boolean));
}

// ---------- rendering ----------

const views = ['homeView', 'resultView', 'historyView', 'tripView', 'compareView', 'shelfView'];

function show(viewId, keepScroll = false) {
  const changed = $(`#${viewId}`).hidden;
  for (const v of views) $(`#${v}`).hidden = v !== viewId;
  if (changed && !keepScroll) window.scrollTo(0, 0);
}

function toggleFlag(id, flag) {
  const entry = findEntry(id);
  if (!entry) return;
  entry[flag] = !entry[flag];
  if (flag === 'bought') entry.boughtAt = entry.bought ? Date.now() : null;
  saveEntry(entry);
  route(true);
}

let historyFilter = 'all';
let selectMode = false;
let selection = [];

function scanFailed(entry) {
  return !running.has(entry.id) && Object.values(entry.status).some((st) => st === 'failed' || st === 'active');
}

function historyItem(entry, opts = {}) {
  if (entry.kind === 'shelf') return shelfHistoryItem(entry);
  const jp = japanPrice(entry).rm;
  const v = verdictFor(entry);
  const isRunning = running.has(entry.id);
  const failed = scanFailed(entry);
  const tagCls = failed ? 'tag-skip' : { buy: 'tag-buy', maybe: 'tag-maybe', skip: 'tag-skip' }[v?.cls] || '';
  const tagText = failed ? 'Failed' : { buy: 'Buy', maybe: 'Maybe', skip: 'Skip' }[v?.cls] || (isRunning ? '…' : '–');
  const serious = seriousIssues(entry).length;
  const meta = [
    entry.bought ? '✓ Bought' : null,
    entry.secondHand ? 'Used' : null,
    toNum(entry.yen) ? yen(entry.yen) : null,
    jp ? rm(jp) : null,
    serious ? `${serious} issue${serious > 1 ? 's' : ''}` : null,
    dateFmt.format(entry.createdAt),
  ].filter(Boolean).join(' · ');
  const dist = distanceFromHere(entry);
  const where = [storeName(entry) || entry.place?.area, dist !== null ? fmtAway(dist) : null].filter(Boolean).join(' · ');
  const selecting = selectMode && location.hash.startsWith('#/history');
  const selected = selecting && selection.includes(entry.id);
  return swipeRow(entry, el('div', { class: 'history-row' },
    el('button', {
      class: `history-item${selected ? ' selected' : ''}`,
      type: 'button',
      'aria-pressed': selecting ? String(selected) : null,
      onclick: () => (selecting ? toggleSelect(entry.id) : (location.hash = `#/scan/${entry.id}`)),
    },
      el('img', { src: entry.thumb, alt: '' }),
      el('div', { class: 'history-body' },
        el('p', { class: 'history-name' }, entry.ai?.product_name || entry.webGuess || 'Unidentified item'),
        el('p', { class: 'history-meta' }, meta),
        where ? el('p', { class: 'history-where' }, where) : null,
        entry.notes ? el('p', { class: 'history-note' }, entry.notes) : null,
        Number.isFinite(opts.saved)
          ? el('p', { class: `history-saved${opts.saved < 0 ? ' neg' : ''}` }, opts.saved >= 0 ? `Saved ${rm(opts.saved)}` : `${rm(-opts.saved)} more than MY`)
          : null,
      ),
      el('span', { class: `tag ${tagCls}` }, tagText),
    ),
    rowActions(entry, isRunning, failed),
  ));
}

// ---------- swipe to delete ----------

function swipeRow(entry, row) {
  const li = el('li', { class: 'swipe' }, el('div', { class: 'swipe-bg', 'aria-hidden': 'true' }, 'Delete'), row);
  attachSwipe(li, row, entry.id);
  return li;
}

// Left swipe past ~a third of the row deletes (with Undo). Vertical drags are left to the page scroll.
function attachSwipe(li, row, id) {
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let state = 'idle';
  let suppressClickUntil = 0;
  const threshold = () => Math.max(90, li.offsetWidth * 0.35);
  const reset = () => {
    state = 'idle';
    row.style.transform = '';
    li.classList.remove('swiping', 'armed');
  };

  row.addEventListener('pointerdown', (e) => {
    if ((e.pointerType === 'mouse' && e.button !== 0) || selectMode || running.has(id)) return;
    startX = e.clientX;
    startY = e.clientY;
    dx = 0;
    state = 'pending';
  });
  row.addEventListener('pointermove', (e) => {
    if (state === 'idle') return;
    const mx = e.clientX - startX;
    const my = e.clientY - startY;
    if (state === 'pending') {
      if (Math.abs(my) > 10 && Math.abs(my) >= Math.abs(mx)) {
        state = 'idle';
        return;
      }
      if (mx > -10 || Math.abs(mx) < Math.abs(my)) return;
      state = 'swiping';
      row.setPointerCapture?.(e.pointerId);
      li.classList.add('swiping');
    }
    dx = Math.min(0, mx);
    row.style.transform = `translateX(${dx}px)`;
    li.classList.toggle('armed', -dx > threshold());
  });
  row.addEventListener('pointerup', () => {
    if (state !== 'swiping') {
      state = 'idle';
      return;
    }
    suppressClickUntil = Date.now() + 400;
    li.classList.remove('swiping');
    state = 'idle';
    if (-dx > threshold()) {
      row.style.transform = `translateX(-${li.offsetWidth + 20}px)`;
      setTimeout(() => removeWithUndo(id), 180);
    } else {
      reset();
    }
  });
  row.addEventListener('pointercancel', reset);
  // A swipe ends with a click on whatever was under the finger; don't let it open the scan.
  row.addEventListener('click', (e) => {
    if (Date.now() < suppressClickUntil) {
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);
}

let pendingDelete = null;

function removeWithUndo(id) {
  removeManyWithUndo([id]);
}

function removeManyWithUndo(ids) {
  const entries = ids.map((id) => findEntry(id)).filter((e) => e && !running.has(e.id));
  if (!entries.length) return;
  finishPendingDelete();
  const gone = new Set(entries.map((e) => e.id));
  store.set('history', loadHistory().filter((e) => !gone.has(e.id)));
  pendingDelete = { entries, timer: setTimeout(finishPendingDelete, 5000) };
  const first = entries[0];
  const name = entries.length > 1 ? `${entries.length} scans` : first.kind === 'shelf' ? 'shelf scan' : first.ai?.product_name || 'scan';
  $('#undoText').textContent = `Deleted ${name.length > 32 ? `${name.slice(0, 30)}…` : name}`;
  $('#undoToast').hidden = false;
  route(true);
}

// The photo is only removed once Undo is no longer possible.
function finishPendingDelete() {
  if (!pendingDelete) return;
  clearTimeout(pendingDelete.timer);
  for (const e of pendingDelete.entries) dropImageIfUnused(e);
  pendingDelete = null;
  $('#undoToast').hidden = true;
}

function rowActions(entry, isRunning, failed) {
  return el('div', { class: 'row-actions' },
    el('button', {
      class: `fav-btn${entry.fav ? ' on' : ''}`,
      type: 'button',
      'aria-label': entry.fav ? 'Remove from favourites' : 'Add to favourites',
      'aria-pressed': String(Boolean(entry.fav)),
      onclick: () => toggleFlag(entry.id, 'fav'),
    }, icon('heart')),
    el('button', {
      class: `rescan-btn${isRunning ? ' spinning' : ''}${failed ? ' attention' : ''}`,
      type: 'button',
      'aria-label': isRunning ? 'Rescanning' : 'Rescan',
      title: 'Rescan',
      disabled: isRunning,
      onclick: () => (entry.kind === 'shelf' ? rescanShelf(entry.id) : rescan(entry.id)),
    }, icon('rescan')),
  );
}

function renderHome() {
  $('#keyNotice').hidden = Boolean(settings.apiKey);
  renderMode();
  const all = historyEntries();
  const favs = all.filter((e) => e.fav).slice(0, 3);
  $('#quickToggle').checked = settings.quick;
  renderRefreshButtons();
  $('#favWrap').hidden = favs.length === 0;
  $('#favList').replaceChildren(...favs.map(historyItem));
  const list = all.slice(0, 3);
  $('#recentWrap').hidden = list.length === 0;
  $('#recentList').replaceChildren(...list.map(historyItem));
  renderRate();
}

function renderMode() {
  const used = settings.secondHand;
  const shelf = settings.scanKind === 'shelf';
  for (const b of document.querySelectorAll('#modeSwitch [data-mode]')) {
    b.setAttribute('aria-checked', String((b.dataset.mode === 'used') === used));
  }
  for (const b of document.querySelectorAll('#kindSwitch [data-kind]')) {
    b.setAttribute('aria-checked', String((b.dataset.kind === 'shelf') === shelf));
  }
  $('#captureLabel').textContent = shelf ? 'Photograph the shelf' : 'Take a photo';
  $('#modeHint').textContent = [
    shelf ? 'Lists every priced item in one photo; check them one by one or all at once.' : null,
    used ? 'Compares against Malaysian second-hand prices and flags any issues on the tag.' : 'Compares against new prices in Malaysia.',
  ].filter(Boolean).join(' ');
}

let historySort = 'recent';

// Everything a search should match on, in one lower-case string.
function searchText(e) {
  return [e.ai?.product_name, e.ai?.brand, e.ai?.variant, e.override, e.webGuess, storeName(e), e.place?.area, e.notes, e.translation,
    ...(e.items || []).map((i) => i.name)].filter(Boolean).join(' ').toLowerCase();
}

let historySearch = '';
let historyTrip = null; // null = the current trip

function renderHistory() {
  let list = historyEntries();
  const trips = ensureTrips();
  const tripFilter = historyTrip || currentTrip().id;
  $('#historyTrip').replaceChildren(
    el('option', { value: 'all' }, 'All trips'),
    ...trips.map((t) => el('option', { value: t.id }, t.name)),
  );
  $('#historyTrip').value = tripFilter;
  if (tripFilter !== 'all') list = list.filter((e) => tripOf(e) === tripFilter);
  if (historyFilter === 'fav') list = list.filter((e) => e.fav);
  if (historyFilter === 'bought') list = list.filter((e) => e.bought);
  const terms = historySearch.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length) list = list.filter((e) => terms.every((t) => searchText(e).includes(t)));
  if (selectMode) list = list.filter((e) => e.kind !== 'shelf');
  for (const b of document.querySelectorAll('#historyFilter [data-filter]')) {
    b.setAttribute('aria-checked', String(b.dataset.filter === historyFilter));
  }
  $('#selectToggle').textContent = selectMode ? 'Done' : 'Select';
  $('#selectBar').hidden = !selectMode;
  $('#selectCount').textContent = `${selection.length} selected`;
  for (const id of ['#selFav', '#selBought', '#selDelete']) $(id).disabled = selection.length === 0;
  $('#selCompare').disabled = selection.length < 2 || selection.length > 3;
  $('#refreshFavsHistory').hidden = historyFilter !== 'fav';
  renderRefreshButtons();
  $('#historyEmpty').textContent = terms.length ? 'Nothing matches that search.' : { fav: 'No favourites yet. Tap ♥ on a scan.', bought: 'Nothing marked as bought yet.' }[historyFilter] || 'No scans yet.';
  if (historySort === 'nearest' && herePos) {
    const d = (e) => distanceFromHere(e) ?? Infinity;
    list = list.sort((a, b) => d(a) - d(b));
  }
  for (const b of document.querySelectorAll('#historySort [data-sort]')) {
    b.setAttribute('aria-checked', String(b.dataset.sort === historySort));
  }
  $('#historyEmpty').hidden = list.length > 0;
  $('#historyList').replaceChildren(...list.map(historyItem));
}

function toggleSelect(id) {
  if (selection.includes(id)) selection = selection.filter((x) => x !== id);
  else selection.push(id);
  renderHistory();
}

function endSelect() {
  selectMode = false;
  selection = [];
}

// Set a flag on every selected scan; if they all have it already, clear it instead.
function bulkFlag(flag) {
  const entries = selection.map((id) => findEntry(id)).filter(Boolean);
  const value = !entries.every((e) => e[flag]);
  for (const e of entries) {
    e[flag] = value;
    if (flag === 'bought') e.boughtAt = value ? e.boughtAt || Date.now() : null;
    saveEntry(e);
  }
  endSelect();
  route(true);
}

// ---------- refresh favourites ----------

let refreshingFavs = null;

async function refreshFavourites() {
  if (refreshingFavs) return;
  if (!settings.apiKey) {
    openSettings();
    return;
  }
  const ids = historyEntries().filter((e) => e.fav && e.kind !== 'shelf' && !running.has(e.id)).map((e) => e.id);
  if (!ids.length) return;
  refreshingFavs = { done: 0, total: ids.length };
  route(true);
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next];
      next += 1;
      await rescan(id, { quiet: true });
      refreshingFavs.done += 1;
      renderRefreshButtons();
    }
  };
  await Promise.all([worker(), worker()]);
  refreshingFavs = null;
  route(true);
  notifyDone();
}

function renderRefreshButtons() {
  for (const id of ['#refreshFavsHome', '#refreshFavsHistory']) {
    const b = $(id);
    b.disabled = Boolean(refreshingFavs);
    b.textContent = refreshingFavs ? `Refreshing ${refreshingFavs.done}/${refreshingFavs.total}…` : '↻ Refresh prices';
  }
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
  $('#secondHandToggle').checked = Boolean(entry.secondHand);
  $('#secondHandLabel').textContent = entry.autoUsed && entry.secondHand
    ? 'Second-hand item (detected from the tag)'
    : 'Second-hand item (compare against MY second-hand)';
  $('#jpHead').textContent = entry.secondHand ? 'Japan used' : 'Japan';

  for (const [key, valueSel, rangeSel] of [['my_new', '#myNew', '#myNewRange'], ['my_used', '#myUsed', '#myUsedRange']]) {
    const r = entry.ai?.[key];
    const lo = toNum(r?.low);
    const hi = toNum(r?.high);
    $(valueSel).textContent = entry.ai || entry.status.search === 'failed' ? rm(rangeValue(r)) : '…';
    $(rangeSel).textContent = lo && hi && lo !== hi ? `${rm(lo)} to ${rm(hi)}` : (entry.ai && !rangeValue(r) ? 'None found' : '');
  }

  const resale = jpUsedYen(entry);
  const lo = toNum(entry.ai?.jp_used_yen?.low);
  const hi = toNum(entry.ai?.jp_used_yen?.high);
  $('#jpUsed').textContent = resale ? yen(resale) : entry.ai || entry.status.search === 'failed' ? '–' : '…';
  $('#jpUsedRange').textContent = resale && fx(entry)
    ? `≈ ${rm(resale * fx(entry))}${lo && hi && lo !== hi ? ` · ${yen(lo)} to ${yen(hi)}` : ''}`
    : entry.ai ? 'None found' : '';

  const cex = cexFor(entry);
  const cexBusy = entry.cexPending && running.has(entry.id);
  const pending = (!entry.ai && entry.status.search !== 'failed') || cexBusy;
  $('#cexSell').textContent = cex.sell ? rm(cex.sell) : pending ? '…' : '–';
  let cexNote = '';
  if (cex.sell) cexNote = `${cex.source === 'live' ? 'Live from CeX' : 'Via web search'}${cex.grade ? ` · grade ${cex.grade}` : ''}`;
  else if (cexBusy) cexNote = 'Checking CeX…';
  else if (entry.ai) cexNote = cex.error ? `Not found · CeX lookup ${cex.error}` : 'Not listed at CeX';
  $('#cexSellNote').textContent = cexNote;
  $('#cexName').textContent = cex.source === 'live' && cex.name ? cex.name : '';
  // Live results take CeX's best offer across grades, so it's a ceiling, not a quote.
  $('#cexCash').textContent = cex.cash ? `${cex.source === 'live' ? 'up to ' : ''}${rm(cex.cash)} cash` : pending ? '…' : '–';
  $('#cexVoucher').textContent = cex.voucher ? `${rm(cex.voucher)} voucher` : '';

  const v = verdictFor(entry);
  $('#verdict').hidden = !v;
  if (v) {
    $('#verdict').className = `verdict ${v.cls}`;
    $('#verdictLabel').textContent = v.label;
    $('#verdictDetail').textContent = v.detail;
  }
}

function renderCondition(entry) {
  const c = conditionFor(entry);
  const panel = $('#conditionPanel');
  const show = c && (c.issues.length || c.grade || c.missing.length || entry.secondHand);
  panel.hidden = !show || !['done', 'failed'].includes(entry.status.vision);
  if (panel.hidden) return;

  $('#conditionGrade').hidden = !c.grade;
  $('#conditionGradeValue').textContent = c.grade || '';
  $('#conditionGradeMeaning').textContent = c.gradeMeaning || '';

  const opts = c.gradeOptions;
  $('#gradeOptions').hidden = opts.length < 2;
  if (opts.length >= 2) {
    $('#gradeOptions').replaceChildren(
      el('p', { class: 'muted small' }, "The tag lists more than one grade. Tap the one you're buying:"),
      ...opts.map((o) => {
        const price = toNum(o.price_yen);
        return el('button', {
          class: `grade-opt${o.grade === c.grade ? ' on' : ''}`,
          type: 'button',
          'aria-pressed': String(o.grade === c.grade),
          onclick: () => pickGrade(entry, o),
        },
          el('span', { class: 'grade-chip' }, o.grade),
          el('span', { class: 'go-meaning' }, o.meaning || ''),
          price ? el('span', { class: 'go-price' }, yen(price), el('small', {}, rm(price * (fx(entry) || 0)))) : null,
        );
      }),
    );
  }

  const items = c.issues.map((i) => el('li', { class: `issue sev-${i.severity}` },
    el('span', { class: 'issue-dot', 'aria-hidden': 'true' }),
    el('div', {},
      el('span', { class: 'issue-en' }, i.en),
      i.jp ? el('span', { class: 'issue-jp', lang: 'ja' }, i.jp) : null,
    ),
    el('span', { class: 'visually-hidden' }, ` (${i.severity === 'good' ? 'positive' : `${i.severity} concern`})`),
  ));
  if (c.missing.length) {
    items.push(el('li', { class: 'issue sev-medium' },
      el('span', { class: 'issue-dot', 'aria-hidden': 'true' }),
      el('div', {}, el('span', { class: 'issue-en' }, `Missing: ${c.missing.join(', ')}`)),
    ));
  }
  $('#issueList').replaceChildren(...items);

  const highs = c.issues.filter((i) => i.severity === 'high').length;
  const concerns = c.issues.filter((i) => i.severity !== 'good').length + (c.missing.length ? 1 : 0);
  const issuesText = highs
    ? `${highs} serious issue${highs > 1 ? 's' : ''}`
    : concerns ? `${concerns} thing${concerns > 1 ? 's' : ''} to check` : '';
  $('#conditionSummary').textContent = `Condition: ${[c.grade ? `grade ${c.grade}` : null, issuesText].filter(Boolean).join(' · ') || (c.source === 'ai' ? 'nothing listed' : 'checking')}`;
  panel.classList.toggle('has-serious', highs > 0);

  let note = '';
  if (!c.issues.length && !c.missing.length) {
    note = c.source === 'ai' ? 'No issues mentioned on the tag.' : 'No issue keywords spotted on the tag.';
  }
  if (c.source === 'local') note = `${note} Quick keyword check; the full read arrives with the price search.`.trim();
  $('#conditionNote').textContent = note;
}

function pickGrade(entry, option) {
  entry.gradePicked = option.grade;
  const price = toNum(option.price_yen);
  if (price) {
    entry.yen = price;
    entry.yenEdited = true;
  }
  saveEntry(entry);
  renderPrices(entry);
  renderCondition(entry);
}

// ---------- exact model ----------

function renderVariant(entry) {
  const ai = entry.ai;
  const lookalikes = (Array.isArray(ai?.lookalikes) ? ai.lookalikes : []).filter((l) => l?.name).slice(0, 3);
  const box = $('#variantBox');
  box.hidden = !ai || (!ai.variant && !lookalikes.length && !entry.override);
  if (box.hidden) return;
  const unsure = !entry.override && ai.variant_confidence === 'low';
  box.classList.toggle('unsure', unsure);
  $('#variantLine').textContent = entry.override
    ? `Model set by you: ${entry.override}`
    : `Exact model: ${ai.product_name || ''}${ai.variant_evidence ? ` (${ai.variant_evidence})` : ''}${unsure ? '. Not certain, check the box.' : ''}`;
  $('#lookalikeHint').textContent = unsure ? 'Could also be one of these. Tap the right one to re-price it:' : 'Easy to mix up with (tap if this is actually it):';
  const buttons = lookalikes.map((l) => el('button', { class: 'lookalike', type: 'button', onclick: () => setOverride(entry.id, l.name) },
    el('span', { class: 'lk-name' }, `It's ${l.name}`),
    el('span', { class: 'lk-how' }, [l.how_to_tell, toNum(l.typical_price_rm) ? `usually ${rm(toNum(l.typical_price_rm))} in MY` : null].filter(Boolean).join(' · ')),
  ));
  if (entry.override) {
    buttons.push(el('button', { class: 'lookalike lk-reset', type: 'button', onclick: () => setOverride(entry.id, null) }, el('span', { class: 'lk-name' }, 'Use the detected model instead')));
  }
  $('#lookalikeWrap').hidden = !buttons.length;
  $('#lookalikes').replaceChildren(...buttons);
}

async function setOverride(id, name) {
  const entry = findEntry(id);
  if (!entry || running.has(id)) return;
  entry.override = name;
  entry.info = null;
  entry.cex = null;
  saveEntry(entry);
  await rescan(id);
}

// ---------- product info ----------

const infoLoading = new Set();

function infoPrompt(entry) {
  const ai = entry.ai || {};
  const jp = japanPrice(entry).rm;
  const name = entry.override || ai.product_name;
  return `You are advising a Malaysian shopper in Japan who is deciding whether to buy: "${name}"${ai.brand ? ` by ${ai.brand}` : ''}${entry.secondHand ? ' (second-hand)' : ''}.
Price here: ${toNum(entry.yen) ? `${yen(paidYen(entry))} (about ${rm(jp)})` : 'unknown'}. In Malaysia it is typically ${rm(rangeValue(ai.my_new))} new and ${rm(rangeValue(ai.my_used))} second-hand.

Use Google Search (reviews, spec pages, Malaysian and Japanese retailers) to write a short buying guide:
- What it is and the features or specs that matter.
- Pros and cons from reviews, and the reviewer consensus with a typical score if there is one.
- Lookalike variants that are easy to confuse with it (older or newer generations, Lite/Pro versions, editions): what differs, how to tell them apart on the box, and typical price in RM.
- Better or better-value alternatives available in Malaysia or Japan: what makes each better or cheaper, for whom, and a typical price.
- Whether it is worth buying at this price, and whether a successor has been released or announced.

Reply with only a JSON object inside a \`\`\`json code block:
{
  "summary": "one or two sentences",
  "key_features": ["3 to 6 short items"],
  "pros": ["up to 4"],
  "cons": ["up to 4"],
  "reviews": "reviewer consensus in one sentence, with a typical score if available",
  "worth_it": { "verdict": "yes | depends | no", "reason": "one sentence" },
  "successor": "newer model if released or announced, else null",
  "variants": [{ "name": "", "difference": "", "how_to_tell": "", "price_rm": 0 }],
  "alternatives": [{ "name": "", "why": "", "price_rm": 0, "price_yen": 0 }]
}
Keep every string short. Up to 3 variants and 4 alternatives. Never invent prices; use null if unknown.`;
}

async function loadInfo(id) {
  const entry = findEntry(id);
  if (!entry?.ai || infoLoading.has(id)) return;
  infoLoading.add(id);
  entry.infoError = null;
  refresh(entry);
  try {
    const { json, sources } = await callGemini(null, infoPrompt(entry));
    entry.info = { ...json, sources, at: Date.now() };
  } catch (e) {
    entry.infoError = e.message;
  }
  infoLoading.delete(id);
  refresh(entry);
}

function renderInfo(entry) {
  const panel = $('#infoPanel');
  panel.hidden = !entry.ai;
  if (panel.hidden) return;
  const info = entry.info;
  const loading = infoLoading.has(entry.id);
  const list = (x) => (Array.isArray(x) ? x.filter(Boolean) : []);
  const verdicts = { yes: ['Worth it', 'yes'], depends: ['Depends', 'depends'], no: ['Probably not', 'no'] };
  const w = verdicts[info?.worth_it?.verdict];
  $('#infoSummary').textContent = w ? `Worth it? ${w[0]}` : 'Is it worth it?';

  if (!info) {
    $('#infoBody').replaceChildren(...[
      el('p', { class: 'muted small' }, 'Features, reviews, lookalike models and better alternatives.'),
      entry.infoError ? el('p', { class: 'error' }, entry.infoError) : null,
      el('button', { class: 'btn btn-block', type: 'button', disabled: loading, onclick: () => loadInfo(entry.id) }, loading ? 'Looking it up…' : 'Get product info'),
    ].filter(Boolean));
    return;
  }

  const shopee = (name) => `https://shopee.com.my/search?keyword=${encodeURIComponent(name)}`;
  const priceText = (r, y) => [toNum(r) ? rm(toNum(r)) : null, toNum(y) ? yen(toNum(y)) : null].filter(Boolean).join(' · ');
  $('#infoBody').replaceChildren(...[
    w ? el('div', { class: `worth worth-${w[1]}` }, el('strong', {}, w[0]), el('span', {}, info.worth_it.reason || '')) : null,
    info.successor ? el('p', { class: 'successor' }, `Newer model: ${info.successor}`) : null,
    info.summary ? el('p', {}, info.summary) : null,
    list(info.key_features).length ? el('ul', { class: 'feature-list' }, list(info.key_features).map((f) => el('li', {}, f))) : null,
    list(info.pros).length || list(info.cons).length ? el('div', { class: 'pros-cons' },
      el('ul', { class: 'pros' }, list(info.pros).map((p) => el('li', {}, p))),
      el('ul', { class: 'cons' }, list(info.cons).map((c) => el('li', {}, c))),
    ) : null,
    info.reviews ? el('p', { class: 'muted small' }, `Reviews: ${info.reviews}`) : null,
    list(info.variants).length ? el('div', {},
      el('h3', { class: 'mini-head' }, "Don't mix up with"),
      el('ul', { class: 'info-list' }, list(info.variants).map((v) => el('li', {},
        el('div', {}, el('strong', {}, v.name), v.difference ? el('span', {}, ` ${v.difference}`) : null),
        v.how_to_tell ? el('small', {}, `How to tell: ${v.how_to_tell}`) : null,
        toNum(v.price_rm) ? el('span', { class: 'info-price' }, rm(toNum(v.price_rm))) : null,
      ))),
    ) : null,
    list(info.alternatives).length ? el('div', {},
      el('h3', { class: 'mini-head' }, 'Alternatives'),
      el('ul', { class: 'info-list' }, list(info.alternatives).map((a) => el('li', {},
        el('div', {}, el('a', { href: shopee(a.name), target: '_blank', rel: 'noopener' }, a.name)),
        a.why ? el('small', {}, a.why) : null,
        priceText(a.price_rm, a.price_yen) ? el('span', { class: 'info-price' }, priceText(a.price_rm, a.price_yen)) : null,
      ))),
    ) : null,
    el('button', { class: 'link small', type: 'button', disabled: loading, onclick: () => loadInfo(entry.id) }, loading ? 'Refreshing…' : 'Refresh info'),
  ].filter(Boolean));
}

function renderCompat(entry) {
  const list = compatFor(entry);
  $('#compatPanel').hidden = !list.length;
  if (!list.length) return;
  const mark = { ok: '✓', warn: '!', bad: '✕' };
  $('#compatList').replaceChildren(...list.map((c) => el('li', { class: `compat-row compat-${c.status}` },
    el('span', { class: 'compat-mark', 'aria-hidden': 'true' }, mark[c.status]),
    el('div', {},
      el('span', { class: 'compat-topic' }, c.topic),
      el('span', { class: 'visually-hidden' }, ` (${{ ok: 'fine', warn: 'check', bad: 'problem' }[c.status]})`),
      el('span', { class: 'compat-note' }, c.note),
    ),
  )));
  const bad = list.filter((c) => c.status === 'bad').length;
  const warn = list.filter((c) => c.status === 'warn').length;
  $('#compatSummary').textContent = bad
    ? `Malaysia: ${bad} problem${bad > 1 ? 's' : ''}`
    : warn ? `Malaysia: ${warn} thing${warn > 1 ? 's' : ''} to check` : 'Works in Malaysia';
  $('#compatPanel').classList.toggle('has-serious', bad > 0);
}

function renderChips(entry) {
  for (const [sel, flag, on, off] of [['#favBtn', 'fav', '♥ Favourite', '♡ Favourite'], ['#boughtBtn', 'bought', '✓ Bought', 'Mark as bought']]) {
    const b = $(sel);
    b.setAttribute('aria-pressed', String(Boolean(entry[flag])));
    b.textContent = entry[flag] ? on : off;
  }
}

let herePosRequested = false;

function renderPlace(entry) {
  const p = entry.place;
  const input = $('#storeInput');
  if (document.activeElement !== input) input.value = storeName(entry) || '';

  const dist = distanceFromHere(entry);
  let area;
  if (p?.lat) {
    area = [p.area, p.accuracy > 150 ? `±${p.accuracy} m` : null, dist !== null && dist > 0.05 ? `${fmtDistance(dist)} from you` : null]
      .filter(Boolean).join(' · ') || 'Location saved';
  } else if (p?.unavailable) {
    area = 'Location not saved (permission off or no signal).';
  } else if (running.has(entry.id) && settings.saveLocation) {
    area = 'Getting location…';
  } else {
    area = 'No location saved for this scan.';
  }
  $('#placeArea').textContent = area;
  $('#directionsLink').hidden = !p?.lat;
  if (p?.lat) $('#directionsLink').href = `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`;
  $('#locateBtn').textContent = p?.lat ? 'Move pin to here' : 'Use current location';

  // Same product scanned at other stores, cheapest first.
  const others = entry.ai ? historyEntries().filter((e) => e.id !== entry.id && e.ai && sameProduct(entry, e)) : [];
  $('#comparePlaces').hidden = others.length === 0;
  if (!others.length) return;
  if (!herePos && !herePosRequested && settings.saveLocation) {
    herePosRequested = true;
    getPosition({ maxAge: 60000 }).then((pos) => {
      if (!pos) return;
      herePos = pos;
      if (current) renderPlace(current);
    });
  }
  const rows = [entry, ...others]
    .map((e) => ({ e, price: japanPrice(e).rm }))
    .sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
  const cheapest = rows[0].price;
  const pick = [entry.id, ...rows.filter((r) => r.e.id !== entry.id).slice(0, 2).map((r) => r.e.id)];
  $('#compareStoresLink').href = `#/compare/${pick.join(',')}`;
  $('#compareList').replaceChildren(...rows.map(({ e, price }) => {
    const d = distanceFromHere(e);
    const isThis = e.id === entry.id;
    return el('li', {},
      el('button', {
        class: `compare-row${isThis ? ' is-this' : ''}`,
        type: 'button',
        disabled: isThis,
        onclick: () => { location.hash = `#/scan/${e.id}`; },
      },
        el('div', { class: 'compare-body' },
          el('span', { class: 'compare-store' }, storeName(e) || e.place?.area || 'Unknown store'),
          el('span', { class: 'compare-meta' }, [
            isThis ? 'This scan' : dateFmt.format(e.createdAt),
            e.secondHand ? 'Used' : null,
            d !== null ? (d < 0.05 ? 'Here' : fmtDistance(d)) : null,
          ].filter(Boolean).join(' · ')),
        ),
        el('div', { class: 'compare-price' },
          el('span', {}, rm(price)),
          price && price === cheapest && rows.length > 1 ? el('span', { class: 'tag tag-buy' }, 'Cheapest') : null,
        ),
      ),
    );
  }));
}

function renderListings(entry) {
  const listings = Array.isArray(entry.ai?.listings) ? entry.ai.listings : [];
  const isJapan = (l) => /mercari|yahoo/i.test(l.platform || '') || (toNum(l.price_yen) && !toNum(l.price_rm));
  const groups = [['new', 'New in Malaysia'], ['used', 'Second-hand in Malaysia'], ['jp', 'Second-hand in Japan']].map(([cond, title]) => {
    const items = listings.filter((l) => (cond === 'jp'
      ? isJapan(l)
      : !isJapan(l) && (l.condition || '').toLowerCase().startsWith(cond === 'new' ? 'new' : 'use')));
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
          el('span', { class: 'price' }, cond === 'jp' ? (toNum(l.price_yen) ? yen(toNum(l.price_yen)) : '–') : rm(toNum(l.price_rm))),
        );
      }),
    );
  }).filter(Boolean);

  const notes = [entry.ai?.notes, entry.ai?.confidence ? `Match confidence: ${entry.ai.confidence}.` : null].filter(Boolean).join(' ');
  $('#listingsPanel').hidden = !entry.ai || (!groups.length && !notes);
  $('#listings').replaceChildren(...groups);
  $('#aiNotes').textContent = notes;
}

// ---------- follow-up questions ----------

const asking = new Set();

function askPrompt(entry, question) {
  const ai = entry.ai || {};
  const earlier = (entry.qa || []).filter((x) => x.a).slice(-3).map((x) => `Q: ${x.q}\nA: ${x.a}`).join('\n');
  return `A Malaysian shopper in a Japanese shop is looking at the item in the photo: "${entry.override || ai.product_name || entry.webGuess || 'unknown item'}"${ai.variant ? ` (${ai.variant})` : ''}.
Tag text: """${(entry.ocrText || entry.contextText || '').slice(0, 1500)}"""
Price here: ${toNum(entry.yen) ? yen(entry.yen) : 'unknown'}. In Malaysia: ${rm(rangeValue(ai.my_new))} new, ${rm(rangeValue(ai.my_used))} second-hand.
${earlier ? `Earlier questions:\n${earlier}\n` : ''}
Their question: "${question}"
Answer in plain English in two to four short sentences, specific to this exact model. Use Google Search when you need facts. If you aren't sure, say so. No preamble and no markdown.`;
}

async function askQuestion(id, question) {
  const entry = findEntry(id);
  if (!entry || !question || asking.has(id)) return;
  if (!settings.apiKey) {
    openSettings();
    return;
  }
  asking.add(id);
  const qa = { q: question, a: null, at: Date.now() };
  entry.qa = [...(entry.qa || []), qa];
  refresh(entry);
  try {
    const image = (await imageDb.get(entry.imageId || entry.id)) || entry.thumb.split(',')[1];
    const { text } = await callGemini(image, askPrompt(entry, question), { raw: true });
    qa.a = text.trim() || 'No answer came back. Try rephrasing.';
  } catch (e) {
    qa.error = e.message;
  }
  asking.delete(id);
  refresh(entry);
}

function renderAsk(entry) {
  $('#askPanel').hidden = !['done', 'failed'].includes(entry.status.vision);
  $('#askBtn').disabled = asking.has(entry.id);
  $('#askBtn').textContent = asking.has(entry.id) ? 'Asking…' : 'Ask';
  $('#qaList').replaceChildren(...(entry.qa || []).map((x) => el('li', {},
    el('p', { class: 'qa-q' }, x.q),
    el('p', { class: `qa-a${x.error ? ' error-text' : ''}` }, x.a || x.error || 'Thinking…'),
  )));
}

// ---------- photo viewer ----------

const zoom = { scale: 1, x: 0, y: 0 };

async function openPhoto(imageId, thumb) {
  const img = $('#viewerImg');
  img.src = thumb;
  resetZoom();
  $('#photoViewer').showModal();
  const full = imageId ? await imageDb.get(imageId) : null;
  if (full && $('#photoViewer').open) img.src = `data:image/jpeg;base64,${full}`;
}

function applyZoom() {
  $('#viewerImg').style.transform = `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`;
}

function resetZoom() {
  Object.assign(zoom, { scale: 1, x: 0, y: 0 });
  applyZoom();
}

// Zoom to `scale` keeping the point under the finger (offset p from the stage centre) where it is.
function zoomTo(scale, p, from = zoom) {
  const s = Math.min(6, Math.max(1, scale));
  zoom.x = p.x - (s / from.scale) * (p.x - from.x);
  zoom.y = p.y - (s / from.scale) * (p.y - from.y);
  zoom.scale = s;
  if (s === 1) resetZoom();
  else applyZoom();
}

function setupViewer() {
  const stage = $('#viewerStage');
  const pts = new Map();
  let pinch = null;
  let pan = null;
  let lastTap = 0;
  const fromCentre = (x, y) => {
    const r = stage.getBoundingClientRect();
    return { x: x - r.left - r.width / 2, y: y - r.top - r.height / 2 };
  };
  stage.addEventListener('pointerdown', (e) => {
    stage.setPointerCapture?.(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), centre: fromCentre((a.x + b.x) / 2, (a.y + b.y) / 2), from: { ...zoom } };
      pan = null;
    } else if (pts.size === 1) {
      pan = { x: e.clientX - zoom.x, y: e.clientY - zoom.y };
      const now = Date.now();
      if (now - lastTap < 300) {
        zoomTo(zoom.scale > 1 ? 1 : 2.5, fromCentre(e.clientX, e.clientY));
        lastTap = 0;
      } else {
        lastTap = now;
      }
    }
  });
  stage.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2 && pinch) {
      const [a, b] = [...pts.values()];
      const centre = fromCentre((a.x + b.x) / 2, (a.y + b.y) / 2);
      zoomTo(pinch.from.scale * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.dist), pinch.centre, pinch.from);
      zoom.x += centre.x - pinch.centre.x;
      zoom.y += centre.y - pinch.centre.y;
      applyZoom();
    } else if (pts.size === 1 && pan && zoom.scale > 1) {
      zoom.x = e.clientX - pan.x;
      zoom.y = e.clientY - pan.y;
      applyZoom();
    }
  });
  const end = (e) => {
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (pts.size === 1) {
      const [p] = [...pts.values()];
      pan = { x: p.x - zoom.x, y: p.y - zoom.y };
    }
    if (zoom.scale <= 1.02) resetZoom();
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  $('#viewerClose').addEventListener('click', () => $('#photoViewer').close());
}

function renderResult(entry) {
  current = entry;
  $('#resPhoto').src = entry.thumb;
  if (document.activeElement !== $('#notesInput')) $('#notesInput').value = entry.notes || '';
  $('#quickBanner').hidden = !(entry.quick && entry.ai && !running.has(entry.id));
  $('#serverInfo').textContent = serverReport(entry.serverJob);
  $('#serverInfo').hidden = !$('#serverInfo').textContent;
  const onServer = entry.serverJob && !entry.serverJob.done;
  $('#serverHint').hidden = !onServer;
  $('#serverHint').classList.toggle('received', Boolean(onServer && entry.serverJob.received));
  $('#serverHint').textContent = onServer && entry.serverJob.received
    ? "✓ Safe to close the app. Your scan server has it; you'll get a notification when it's done."
    : 'Sending the photo to your scan server… keep the app open until this says it\'s safe to close.';
  renderAsk(entry);
  $('#resName').textContent = entry.ai?.product_name || entry.webGuess || (running.has(entry.id) ? 'Reading…' : 'Unidentified item');
  $('#resBrand').textContent = entry.ai?.brand || '';
  $('#resTime').textContent = dateFmt.format(entry.createdAt);

  renderSteps(entry);
  $('#resError').hidden = entry.errors.length === 0;
  $('#resError').textContent = entry.errors.join('\n');

  const visionDone = entry.status.vision === 'done' || entry.status.vision === 'failed';
  $('#prices').hidden = !visionDone;
  $('#toggles').hidden = !visionDone;
  renderChips(entry);
  renderPrices(entry);
  renderCondition(entry);
  renderCompat(entry);
  renderVariant(entry);
  renderInfo(entry);
  renderPlace(entry);

  const q = searchQuery(entry);
  $('#searchLinks').hidden = !q;
  $('#shopeeLink').href = `https://shopee.com.my/search?keyword=${encodeURIComponent(q)}`;
  $('#carousellLink').href = `https://www.carousell.com.my/search/${encodeURIComponent(q)}`;
  const qJa = entry.ai?.search_query_ja || q;
  $('#mercariLink').href = `https://jp.mercari.com/search?keyword=${encodeURIComponent(qJa)}`;
  $('#cexLink').href = cexFor(entry).url || `https://my.webuy.com/search?stext=${encodeURIComponent(q)}`;
  $('#yahooLink').href = `https://auctions.yahoo.co.jp/search/search?p=${encodeURIComponent(qJa)}`;

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
  $('#rescanBtn').disabled = isRunning;
  $('#rescanBtn').classList.toggle('spinning', isRunning);
  $('#rescanBtn').classList.toggle('attention', scanFailed(entry));
  $('#deleteBtn').hidden = isRunning;
}

// ---------- trip spending ----------

// What the same thing costs in Malaysia, like for like: a second-hand scan is measured against MY second-hand.
function malaysiaBaseline(e) {
  return e.secondHand
    ? rangeValue(e.ai?.my_used) || rangeValue(e.ai?.my_new)
    : rangeValue(e.ai?.my_new) || rangeValue(e.ai?.my_used);
}

function paidYen(e) {
  const y = toNum(e.yen);
  if (!y) return 0;
  return e.taxIncluded === false ? y * (1 + TAX) : y;
}

// Tax-free needs ¥5,000 at one store on one day, so group bought items that way.
function tripSummary() {
  const tripId = currentTrip().id;
  const bought = historyEntries().filter((e) => e.bought && e.kind !== 'shelf' && tripOf(e) === tripId);
  const groups = new Map();
  for (const e of bought) {
    const when = e.boughtAt || e.createdAt;
    const storeLabel = storeName(e) || e.place?.area || 'Unknown store';
    const key = `${storeLabel.toLowerCase()}|${new Date(when).toDateString()}`;
    if (!groups.has(key)) groups.set(key, { store: storeLabel, when, items: [], yen: 0 });
    const g = groups.get(key);
    g.items.push(e);
    g.yen += paidYen(e);
  }
  let spentRm = 0;
  let spentYen = 0;
  let refundRm = 0;
  for (const e of bought) {
    spentYen += paidYen(e);
    spentRm += paidYen(e) * (fx(e) || 0);
  }
  for (const g of groups.values()) {
    g.eligible = g.yen >= TAX_FREE_MIN_YEN;
    if (!g.eligible) continue;
    // Assume you claim it wherever you qualify; that's the point of tracking it.
    for (const e of g.items) refundRm += (paidYen(e) * TAX / (1 + TAX)) * (fx(e) || 0);
  }
  // Saved = Malaysian price minus what you actually paid here (after the refund where the store qualifies).
  const savedById = new Map();
  let savedRm = 0;
  for (const g of groups.values()) {
    for (const e of g.items) {
      const base = malaysiaBaseline(e);
      if (!base || !fx(e) || !paidYen(e)) continue;
      const netYen = g.eligible ? paidYen(e) / (1 + TAX) : paidYen(e);
      const saved = base - netYen * fx(e);
      savedById.set(e.id, saved);
      savedRm += saved;
    }
  }
  return { bought, groups: [...groups.values()].sort((a, b) => b.when - a.when), spentRm, spentYen, refundRm, savedRm, savedById };
}

function renderTrip() {
  const t = tripSummary();
  const trip = currentTrip();
  $('#tripSelect').replaceChildren(
    ...ensureTrips().map((tr) => el('option', { value: tr.id }, tr.name)),
    el('option', { value: '__new' }, '＋ New trip…'),
  );
  $('#tripSelect').value = trip.id;
  const budget = toNum(trip.budget);
  const input = $('#budgetInput');
  if (document.activeElement !== input) input.value = budget ?? '';
  const net = t.spentRm - t.refundRm;
  $('#tripSpent').textContent = rm(t.spentRm);
  $('#tripSpentYen').textContent = t.spentYen ? yen(t.spentYen) : '';
  $('#tripRefund').textContent = t.refundRm ? `− ${rm(t.refundRm)}` : rm(0);
  $('#tripLeft').textContent = !budget ? 'Set a budget' : net > budget ? `${rm(net - budget)} over` : rm(budget - net);
  $('#tripLeft').classList.toggle('over', Boolean(budget) && net > budget);
  $('#tripMeterWrap').hidden = !budget;
  if (budget) $('#tripMeter').style.width = `${Math.min(100, (net / budget) * 100)}%`;
  $('#tripMeter').classList.toggle('over', Boolean(budget) && net > budget);

  $('#storeHead').hidden = !t.groups.length;
  $('#storeList').replaceChildren(...t.groups.map((g) => el('li', { class: 'store-row' },
    el('div', { class: 'compare-body' },
      el('span', { class: 'compare-store' }, g.store),
      el('span', { class: 'compare-meta' }, `${new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(g.when)} · ${g.items.length} item${g.items.length > 1 ? 's' : ''} · ${yen(g.yen)}`),
    ),
    g.eligible
      ? el('span', { class: 'tag tag-buy' }, 'Tax-free ✓')
      : el('span', { class: 'tag tag-maybe' }, `${yen(TAX_FREE_MIN_YEN - g.yen)} to tax-free`),
  )));
  const counted = t.savedById.size;
  $('#tripSaved').hidden = counted === 0;
  $('#tripSaved').classList.toggle('neg', t.savedRm < 0);
  $('#tripSavedValue').textContent = t.savedRm >= 0 ? `${rm(t.savedRm)} saved` : `${rm(-t.savedRm)} more`;
  $('#tripSavedNote').textContent = `${t.savedRm >= 0 ? 'vs' : 'than'} buying in Malaysia${counted < t.bought.length ? ` · ${counted} of ${t.bought.length} items had Malaysian prices` : ''}`;
  $('#boughtSaved').textContent = counted ? (t.savedRm >= 0 ? `${rm(t.savedRm)} saved` : `${rm(-t.savedRm)} more than MY`) : '';
  $('#boughtSaved').classList.toggle('neg', t.savedRm < 0);

  $('#tripEmpty').hidden = t.bought.length > 0;
  $('#boughtList').replaceChildren(...t.bought.map((e) => historyItem(e, { saved: t.savedById.get(e.id) })));
}

// ---------- side-by-side compare ----------

function renderCompare(ids) {
  const items = ids.map(findEntry).filter(Boolean).slice(0, 3);
  const wrap = $('#cmpTable');
  wrap.style.setProperty('--cols', items.length || 1);
  if (items.length < 2) {
    wrap.replaceChildren(el('p', { class: 'muted' }, 'Pick at least two scans in History to compare.'));
    return;
  }
  const saving = (e) => {
    const jp = japanPrice(e).rm;
    const base = malaysiaBaseline(e);
    return jp && base ? base - jp : null;
  };
  // Each row: label, cell renderer, and optionally a score to highlight the best (lowest) value.
  const rows = [
    ['Store', (e) => storeName(e) || e.place?.area || '–'],
    ['Japan price', (e) => [toNum(e.yen) ? yen(paidYen(e)) : '–', el('small', {}, rm(japanPrice(e).rm))], (e) => japanPrice(e).rm],
    ['MY new', (e) => rm(rangeValue(e.ai?.my_new)), null],
    ['MY second-hand', (e) => rm(rangeValue(e.ai?.my_used)), null],
    ['JP second-hand', (e) => (jpUsedYen(e) ? [yen(jpUsedYen(e)), el('small', {}, rm(jpUsedYen(e) * (fx(e) || 0)))] : '–'), (e) => jpUsedYen(e)],
    ['CeX Malaysia sells', (e) => (cexFor(e).sell ? rm(cexFor(e).sell) : '–'), (e) => cexFor(e).sell],
    ['CeX buys at', (e) => (cexFor(e).cash ? `${rm(cexFor(e).cash)} cash` : '–'), (e) => (cexFor(e).cash ? -cexFor(e).cash : null)],
    ['You save vs MY', (e) => {
      const s = saving(e);
      return s === null ? '–' : s >= 0 ? rm(s) : `${rm(-s)} more`;
    }, (e) => (saving(e) === null ? null : -saving(e))],
    ['Verdict', (e) => {
      const v = verdictFor(e);
      const cls = { buy: 'tag-buy', maybe: 'tag-maybe', skip: 'tag-skip' }[v?.cls] || '';
      return el('span', { class: `tag ${cls}` }, v?.label || '–');
    }],
    ['Condition', (e) => {
      const n = seriousIssues(e).length;
      return n ? `${n} serious issue${n > 1 ? 's' : ''}` : e.secondHand ? 'No serious issues' : '–';
    }],
    ['Works in Malaysia', (e) => {
      const c = compatFor(e);
      const bad = c.filter((x) => x.status === 'bad').length;
      const warn = c.filter((x) => x.status === 'warn').length;
      return bad ? `${bad} problem${bad > 1 ? 's' : ''}` : warn ? `${warn} to check` : c.length ? 'Yes' : '–';
    }],
  ];
  if (herePos) {
    rows.push(['Distance', (e) => {
      const d = distanceFromHere(e);
      return d === null ? '–' : d < 0.05 ? 'Here' : fmtDistance(d);
    }, (e) => distanceFromHere(e)]);
  }

  const head = el('div', { class: 'cmp-head' }, items.map((e) => el('a', { class: 'cmp-item', href: `#/scan/${e.id}` },
    el('img', { src: e.thumb, alt: '' }),
    el('span', {}, e.ai?.product_name || e.webGuess || 'Unidentified item'),
  )));
  const body = rows.map(([label, cell, score]) => {
    const cells = items.map(cell);
    if (cells.every((c) => c === '–')) return null; // nothing to compare on this row
    let best = null;
    if (score) {
      const scores = items.map(score).filter((x) => x !== null && x !== undefined && Number.isFinite(x));
      if (scores.length > 1 && new Set(scores).size > 1) best = Math.min(...scores);
    }
    return el('div', { class: 'cmp-row' },
      el('p', { class: 'cmp-label' }, label),
      el('div', { class: 'cmp-cells' }, items.map((e, i) => {
        const isBest = best !== null && score(e) === best;
        return el('div', { class: `cmp-cell${isBest ? ' best' : ''}` }, cells[i]);
      })),
    );
  }).filter(Boolean);
  wrap.replaceChildren(head, ...body);
}

// ---------- routing ----------

// keepScroll: re-render the current view in place (e.g. after tapping ♥) without jumping to the top.
function renderNav(hash) {
  const active = hash.startsWith('#/history') || hash.startsWith('#/compare') ? 'history' : hash.startsWith('#/trip') ? 'trip' : 'home';
  for (const b of document.querySelectorAll('.bottom-nav [data-nav]')) {
    if (b.dataset.nav === active) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
}

function route(keepScroll = false) {
  const hash = location.hash || '#/';
  renderNav(hash);
  $('#tripLine').textContent = `Trip: ${currentTrip().name}`;
  if (!hash.startsWith('#/history') && selectMode) {
    selectMode = false;
    selection = [];
  }
  const scan = hash.match(/^#\/scan\/([\w-]+)/);
  if (scan) {
    const entry = findEntry(scan[1]);
    if (entry) {
      if (current?.id !== entry.id) currentImageB64 = null;
      renderResult(entry);
      show('resultView', keepScroll);
      return;
    }
  }
  const shelf = hash.match(/^#\/shelf\/([\w-]+)/);
  if (shelf && findEntry(shelf[1])) {
    renderShelf(findEntry(shelf[1]));
    show('shelfView', keepScroll);
    return;
  }
  const cmp = hash.match(/^#\/compare\/([\w,-]+)/);
  if (cmp) {
    renderCompare(cmp[1].split(','));
    show('compareView', keepScroll);
    return;
  }
  if (hash.startsWith('#/trip')) {
    renderTrip();
    show('tripView', keepScroll);
    return;
  }
  if (hash.startsWith('#/history')) {
    renderHistory();
    show('historyView', keepScroll);
    return;
  }
  renderHome();
  show('homeView', keepScroll);
}

// ---------- settings ----------

function openSettings() {
  $('#apiKeyInput').value = settings.apiKey;
  $('#geminiKeyInput').value = store.get('geminiKey', '');
  $('#modelInput').value = store.get('model', '') || DEFAULT_MODEL;
  $('#defaultTaxFree').checked = settings.taxFree;
  $('#saveLocationToggle').checked = settings.saveLocation;
  $('#autoInfoToggle').checked = settings.autoInfo;
  $('#buzzToggle').checked = settings.buzz;
  $('#serverUrlInput').value = settings.serverUrl;
  $('#ntfyInput').value = settings.ntfyTopic;
  $('#ntfyTokenInput').value = settings.ntfyToken;
  $('#serverTestResult').textContent = '';
  $('#settingsDialog').showModal();
}

$('#settingsForm').addEventListener('submit', () => {
  store.set('apiKey', $('#apiKeyInput').value.trim());
  store.set('geminiKey', $('#geminiKeyInput').value.trim());
  const model = $('#modelInput').value.trim();
  store.set('model', model && model !== DEFAULT_MODEL ? model : '');
  store.set('taxFree', $('#defaultTaxFree').checked);
  store.set('saveLocation', $('#saveLocationToggle').checked);
  store.set('autoInfo', $('#autoInfoToggle').checked);
  store.set('buzz', $('#buzzToggle').checked);
  saveServerSettings();
  route();
});

$('#clearHistoryBtn').addEventListener('click', () => {
  if (!confirm('Delete all saved scans?')) return;
  store.set('history', []);
  imageDb.clear();
  $('#settingsDialog').close();
  location.hash = '#/';
  route();
});

// ---------- events ----------

$('#settingsBtn').addEventListener('click', openSettings);
document.querySelectorAll('[data-open-settings]').forEach((b) => b.addEventListener('click', openSettings));
$('#homeBtn').addEventListener('click', () => { location.hash = '#/'; });
$('#historyBtn').addEventListener('click', () => { location.hash = '#/history'; });
$('#tripBtn').addEventListener('click', () => { location.hash = '#/trip'; });
$('#seeFavsBtn').addEventListener('click', () => {
  historyFilter = 'fav';
  location.hash = '#/history';
});
$('#favBtn').addEventListener('click', () => current && toggleFlag(current.id, 'fav'));
$('#boughtBtn').addEventListener('click', () => current && toggleFlag(current.id, 'bought'));
$('#budgetInput').addEventListener('input', (e) => {
  saveTrip({ ...currentTrip(), budget: toNum(e.target.value) });
  renderTrip();
});
$('#tripSelect').addEventListener('change', (e) => {
  if (e.target.value === '__new') newTrip();
  else store.set('currentTrip', e.target.value);
  historyTrip = null;
  route(true);
});
$('#tripRename').addEventListener('click', () => {
  const trip = currentTrip();
  const name = prompt('Rename trip', trip.name);
  if (name?.trim()) saveTrip({ ...trip, name: name.trim() });
  route(true);
});
$('#historySearch').addEventListener('input', (e) => {
  historySearch = e.target.value;
  renderHistory();
});
$('#historyTrip').addEventListener('change', (e) => {
  historyTrip = e.target.value;
  renderHistory();
});
$('#refreshFavsHome').addEventListener('click', refreshFavourites);
$('#refreshFavsHistory').addEventListener('click', refreshFavourites);
$('#quickToggle').addEventListener('change', (e) => store.set('quick', e.target.checked));
document.addEventListener('pointerdown', unlockAudio, { passive: true });
for (const b of document.querySelectorAll('#historyFilter [data-filter]')) {
  b.addEventListener('click', () => {
    historyFilter = b.dataset.filter;
    renderHistory();
  });
}
$('#selectToggle').addEventListener('click', () => {
  const on = !selectMode;
  endSelect();
  selectMode = on;
  renderHistory();
});
$('#selCompare').addEventListener('click', () => {
  if (selection.length >= 2 && selection.length <= 3) location.hash = `#/compare/${selection.join(',')}`;
});
$('#selFav').addEventListener('click', () => bulkFlag('fav'));
$('#selBought').addEventListener('click', () => bulkFlag('bought'));
$('#selDelete').addEventListener('click', () => {
  const ids = [...selection];
  endSelect();
  removeManyWithUndo(ids);
});
$('#seeAllBtn').addEventListener('click', () => {
  historyFilter = 'all';
  location.hash = '#/history';
});

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
  renderCondition(current);
}

$('#yenInput').addEventListener('input', (e) => editCurrent((entry) => {
  entry.yen = toNum(e.target.value);
  entry.yenEdited = true;
}));
$('#taxInclToggle').addEventListener('change', (e) => editCurrent((entry) => { entry.taxIncluded = e.target.checked; }));
$('#taxFreeToggle').addEventListener('change', (e) => editCurrent((entry) => { entry.taxFree = e.target.checked; }));
$('#secondHandToggle').addEventListener('change', (e) => editCurrent((entry) => {
  entry.secondHand = e.target.checked;
  entry.secondHandEdited = true;
  entry.autoUsed = false;
}));

for (const b of document.querySelectorAll('#modeSwitch [data-mode]')) {
  b.addEventListener('click', () => {
    store.set('secondHand', b.dataset.mode === 'used');
    renderMode();
  });
}
for (const b of document.querySelectorAll('#kindSwitch [data-kind]')) {
  b.addEventListener('click', () => {
    store.set('scanKind', b.dataset.kind);
    renderMode();
  });
}

$('#rescanBtn').addEventListener('click', () => current && rescan(current.id));
$('#navHome').addEventListener('click', () => { location.hash = '#/'; });
$('#resPhoto').addEventListener('click', () => current && openPhoto(current.imageId || current.id, current.thumb));
$('#notesInput').addEventListener('input', (e) => {
  if (!current) return;
  current.notes = e.target.value;
  saveEntry(current);
});
$('#fixNameBtn').addEventListener('click', () => {
  if (!current) return;
  $('#fixName').hidden = !$('#fixName').hidden;
  $('#fixNameInput').value = current.override || current.ai?.product_name || current.webGuess || '';
  if (!$('#fixName').hidden) $('#fixNameInput').focus();
});
$('#fixName').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#fixNameInput').value.trim();
  if (!current || !name) return;
  $('#fixName').hidden = true;
  setOverride(current.id, name);
});
$('#fullCheckBtn').addEventListener('click', () => {
  if (!current || running.has(current.id)) return;
  current.quick = false;
  saveEntry(current);
  rescan(current.id);
});
$('#askForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('#askInput').value.trim();
  if (!current || !q) return;
  $('#askInput').value = '';
  askQuestion(current.id, q);
});
setupViewer();

$('#storeInput').addEventListener('input', (e) => {
  if (!current) return;
  current.place = { ...(current.place || {}), name: e.target.value.trim() || null };
  saveEntry(current);
});
$('#storeInput').addEventListener('change', () => current && renderPlace(current));

$('#locateBtn').addEventListener('click', async () => {
  const entry = current;
  if (!entry) return;
  $('#placeArea').textContent = 'Getting location…';
  await locate(entry, () => refresh(entry));
});

for (const b of document.querySelectorAll('#historySort [data-sort]')) {
  b.addEventListener('click', async () => {
    historySort = b.dataset.sort;
    if (historySort === 'nearest' && !herePos) {
      $('#historyHint').hidden = false;
      $('#historyHint').textContent = 'Getting your location…';
      herePos = await getPosition({ maxAge: 60000 });
      $('#historyHint').textContent = herePos ? '' : "Couldn't get your location. Check location permission for this site.";
      $('#historyHint').hidden = Boolean(herePos);
    }
    renderHistory();
  });
}
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

// The app never reloads itself (hash routing), so check for a newer release on launch and whenever it comes back on screen.
async function checkForUpdate() {
  try {
    const r = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
    const { version } = await r.json();
    $('#updateBar').hidden = !version || version === APP_VERSION;
  } catch {
    // offline: try again next time
  }
}

$('#undoBtn').addEventListener('click', () => {
  if (!pendingDelete) return;
  clearTimeout(pendingDelete.timer);
  for (const e of pendingDelete.entries) saveEntry(e);
  pendingDelete = null;
  $('#undoToast').hidden = true;
  route(true);
});

$('#updateBtn').addEventListener('click', () => {
  if (running.size && !confirm('A scan is still running. Reload anyway?')) return;
  location.reload();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    checkForUpdate();
    resumeWork();
  } else {
    lastHiddenAt = Date.now();
  }
});

function saveServerSettings() {
  store.set('serverUrl', $('#serverUrlInput').value.trim());
  store.set('ntfyTopic', $('#ntfyInput').value.trim());
  store.set('ntfyToken', $('#ntfyTokenInput').value.trim());
}

$('#ntfyNew').addEventListener('click', () => {
  const random = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(36).padStart(2, '0')).join('');
  $('#ntfyInput').value = `kaimono-${random}`;
});
$('#ntfyCopy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#ntfyInput').value);
    $('#serverTestResult').textContent = 'Topic copied.';
  } catch {
    $('#ntfyInput').select();
  }
});
// Tests each hop separately so a missing notification can be pinned on the subscription, the server or ntfy.
$('#serverTest').addEventListener('click', async () => {
  saveServerSettings();
  const lines = [];
  const show = () => { $('#serverTestResult').replaceChildren(...lines.map((l) => el('span', { class: 'test-line' }, l))); };
  if (settings.ntfyTopic) {
    lines.push('1. Phone → ntfy: sending…');
    show();
    try {
      const headers = settings.ntfyToken ? { Authorization: `Bearer ${settings.ntfyToken}` } : {};
      const res = await fetch('https://ntfy.sh/', {
        method: 'POST',
        headers,
        body: JSON.stringify({ topic: settings.ntfyTopic, title: 'Kaimono Check', message: 'Test from your phone: your ntfy subscription works.' }),
      });
      lines[0] = `1. Phone → ntfy: ${describeNtfy({ code: res.status, body: (await res.text()).slice(0, 120) })}`;
    } catch {
      lines[0] = "1. Phone → ntfy: couldn't reach ntfy.sh.";
    }
  } else {
    lines.push('1. No ntfy topic yet: tap New, then subscribe to it in the ntfy app.');
  }
  if (!settings.serverUrl) {
    lines.push('2. No scan server URL yet.');
    show();
    return;
  }
  lines.push('2. App → your server: checking…');
  show();
  try {
    const res = await serverCall({ action: 'ping', notify: notifyTarget() }, 30000);
    lines[1] = `2. App → your server: OK${res.version < 2 ? ' (old version of Code.gs: paste the new one and deploy a New version)' : ''}`;
    if (settings.ntfyTopic) lines.push(`3. Server → ntfy: ${res.ntfy ? describeNtfy(res.ntfy) : 'no report (old Code.gs)'}`);
  } catch (e) {
    lines[1] = `2. App → your server: ${e.message.startsWith('Scan server') ? e.message.replace('Scan server: ', '') : "couldn't reach it. Check the URL (ends in /exec)."}`;
  }
  show();
});
checkForUpdate();
resumeWork();
