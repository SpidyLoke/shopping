// Kaimono backend: one scan, run with the API keys held here instead of on the phone.
//
// Pure logic. index.js wires in Firestore, the keys and fetch; the tests run the same code with
// fakes. Each scan:
//   1. reserves one from the user's monthly allowance (and the daily caps that protect the bill)
//   2. reads the photos with Google Vision
//   3. if the tag has a barcode someone scanned in the last few days, reuses those market prices and
//      only asks Gemini to read this tag (no search, so it's cheap); such scans don't use the allowance
//   4. otherwise asks Gemini with Google Search, and keeps the market prices for that barcode
//   5. checks CeX Malaysia
// The result is the same shape the Apps Script scan server returns, so the app handles both alike.

const DAY = 24 * 60 * 60 * 1000;
const MYT = 8 * 60 * 60 * 1000; // allowances reset at midnight Malaysia time
const MAX_PHOTOS = 5;
const MAX_IMAGE_CHARS = 3_000_000; // base64, about 2.2 MB per photo; the app sends ~0.3 MB
const JOB_TTL = 6 * 60 * 60 * 1000;
const CEX_SEARCH = 'https://search.webuy.io/1/indexes/*/queries';

export class ScanError extends Error {
  // `code` is a Firebase callable error code (the app sees it as functions/<code>).
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export const monthKey = (now) => new Date(now + MYT).toISOString().slice(0, 7);
const dayKey = (now) => new Date(now + MYT).toISOString().slice(0, 10);

function resetsAt(now) {
  const d = new Date(now + MYT);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - MYT;
}

function usageOf(user, now, limits) {
  const plan = user?.plan === 'pro' ? 'pro' : 'free';
  const month = monthKey(now);
  return { plan, used: user?.month === month ? user.used || 0 : 0, limit: plan === 'pro' ? limits.pro : limits.free, month, resetsAt: resetsAt(now) };
}

export async function usageFor(uid, { db, now = Date.now(), limits }) {
  const user = await db.get(`users/${uid}`);
  const u = usageOf(user, now, limits);
  return { ...u, asks: { used: user?.asksMonth === u.month ? user.asksUsed || 0 : 0, limit: u.plan === 'pro' ? limits.proAsks : limits.freeAsks } };
}

// One scan from the allowance, plus the project-wide daily cap and a per-connection daily cap
// (someone reinstalling to get a fresh allowance still shares their connection).
async function reserve(db, { uid, ipHash, now, limits }) {
  return db.txn(async (t) => {
    const day = dayKey(now);
    const user = (await t.get(`users/${uid}`)) || {};
    const counter = (await t.get(`counters/day-${day}`)) || {};
    const ip = ipHash ? (await t.get(`ipDaily/${day}-${ipHash}`)) || {} : null;
    const u = usageOf(user, now, limits);
    if (u.used >= u.limit) {
      throw new ScanError('resource-exhausted', `No scans left this month (${u.limit} a month on the ${u.plan} plan).`, { reason: 'quota', ...u });
    }
    if ((counter.scans || 0) >= limits.daily) {
      throw new ScanError('resource-exhausted', 'Kaimono has hit its scan limit for today. Try again tomorrow, or scan with your own keys (Settings).', { reason: 'daily' });
    }
    if (ip && (ip.scans || 0) >= limits.perIp) {
      throw new ScanError('resource-exhausted', 'Too many scans from this connection today.', { reason: 'connection' });
    }
    t.set(`users/${uid}`, { ...user, plan: u.plan, month: u.month, used: u.used + 1, updatedAt: now });
    t.set(`counters/day-${day}`, { scans: (counter.scans || 0) + 1 });
    if (ip) t.set(`ipDaily/${day}-${ipHash}`, { scans: (ip.scans || 0) + 1, expireAt: new Date(now + 2 * DAY) });
    return { ...u, used: u.used + 1 };
  });
}

// Gives the scan back: Gemini failed, or the prices came from the barcode cache.
async function refund(db, { uid, now, limits }) {
  return db.txn(async (t) => {
    const user = (await t.get(`users/${uid}`)) || {};
    const u = usageOf(user, now, limits);
    if (u.used > 0) t.set(`users/${uid}`, { ...user, used: u.used - 1, updatedAt: now });
    return { ...u, used: Math.max(0, u.used - 1) };
  });
}

function checkInput(input) {
  const images = Array.isArray(input?.images) ? input.images : [];
  if (!images.length || images.length > MAX_PHOTOS || !images.every((i) => typeof i === 'string' && i.length > 100 && i.length <= MAX_IMAGE_CHARS)) {
    throw new ScanError('invalid-argument', `Send 1 to ${MAX_PHOTOS} photos.`);
  }
  const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  const focus = input.focus && text(input.focus.name, 200)
    ? { name: text(input.focus.name, 200), yen: Number.isFinite(input.focus.yen) ? input.focus.yen : null }
    : null;
  return {
    images,
    jobId: text(input.jobId, 40)?.replace(/[^\w-]/g, '') || null,
    secondHand: input.secondHand === true,
    quick: input.quick === true,
    clothes: input.clothes === true,
    override: text(input.override, 200),
    focus,
  };
}

async function google(fetch, url, body, label) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${label}: ${data.error?.message || `HTTP ${res.status}`}`);
  return data;
}

async function readPhotos({ fetch, keys }, images) {
  const d = await google(fetch, `https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(keys.vision)}`, {
    requests: images.map((content) => ({
      image: { content },
      features: [{ type: 'DOCUMENT_TEXT_DETECTION' }, { type: 'WEB_DETECTION', maxResults: 5 }],
      imageContext: { languageHints: ['ja', 'en'] },
    })),
  }, 'Vision');
  const ok = (d.responses || []).filter((r) => !r.error);
  if (!ok.length) throw new Error(`Vision: ${d.responses?.[0]?.error?.message || 'no answer'}`);
  const guesses = [...new Set(ok.map((r) => r.webDetection?.bestGuessLabels?.[0]?.label).filter(Boolean))];
  return {
    ocrText: ok.map((r) => (r.fullTextAnnotation?.text || '').trim()).filter(Boolean).join('\n\n'),
    webGuess: guesses.join('; '),
  };
}

async function askGemini({ fetch, keys, model }, images, prompt, search) {
  const body = { contents: [{ role: 'user', parts: [...images.map((data) => ({ inline_data: { mime_type: 'image/jpeg', data } })), { text: prompt }] }] };
  if (search) body.tools = [{ google_search: {} }];
  const d = await google(fetch, `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(keys.gemini)}`, body, 'Gemini');
  const cand = d.candidates?.[0] || {};
  const text = (cand.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
  if (!text) throw new Error(`Gemini returned no answer (${cand.finishReason || d.promptFeedback?.blockReason || 'no reason given'}).`);
  const chunks = (cand.groundingMetadata?.groundingChunks || []).map((c) => c.web).filter(Boolean).map((w) => ({ title: w.title || w.uri, uri: w.uri }));
  return { text, chunks };
}

export function parseJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

const fence = (obj) => `\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``;

async function cexLookup({ fetch, cexIndex }, query) {
  const params = `query=${encodeURIComponent(query)}&hitsPerPage=30&filters=${encodeURIComponent('boxVisibilityOnWeb=1')}`;
  const res = await fetch(CEX_SEARCH, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: JSON.stringify({ requests: [{ indexName: cexIndex, params }] }) });
  if (!res.ok) throw new Error(`CeX: HTTP ${res.status}`);
  const d = await res.json();
  const hits = (d.results?.[0]?.hits || []).map((h) => ({
    boxId: h.boxId, boxName: h.boxName, sellPrice: h.sellPrice, cashPriceCalculated: h.cashPriceCalculated, exchangePriceCalculated: h.exchangePriceCalculated,
  }));
  return { query, hits };
}

export async function runScan(rawInput, { uid, ipHash = null, deps }) {
  const { db, prompts, limits, cacheDays = 7 } = deps;
  const clock = deps.clock || Date.now;
  const now = clock();
  const input = checkInput(rawInput);
  const jobPath = input.jobId ? `jobs/${uid}-${input.jobId}` : null;
  let usage = await reserve(db, { uid, ipHash, now, limits });
  const out = { status: 'running', startedAt: now };
  if (jobPath) await db.set(jobPath, { uid, out, expireAt: new Date(now + JOB_TTL) });
  const { images } = input;

  let ocr = '';
  let guess = '';
  try {
    out.vision = await readPhotos(deps, images);
    ({ ocrText: ocr, webGuess: guess } = out.vision);
  } catch (e) {
    out.visionError = e.message;
  }

  // Market prices are kept per barcode and condition, never for a corrected name, one item on a
  // shelf, a quick scan or clothes (whose barcode can cover several sizes).
  const barcode = prompts.findBarcodes(ocr)[0] || null;
  const cacheId = barcode && !input.override && !input.focus && !input.quick && !input.clothes ? `${barcode}-${input.secondHand ? 'used' : 'new'}` : null;
  let cached = cacheId ? await db.get(`products/${cacheId}`) : null;
  if (cached && now - cached.at > cacheDays * DAY) cached = null;

  let ai = null;
  try {
    if (cached) {
      const g = await askGemini(deps, images, prompts.buildTagPrompt({ ocrText: ocr, photos: images.length, productName: cached.market.product_name }), false);
      const tag = parseJson(g.text) || {};
      ai = { ...cached.market };
      for (const k of prompts.TAG_KEYS) if (k in tag) ai[k] = tag[k];
      out.gemini = { text: fence(ai), chunks: cached.chunks || [] };
      out.cached = { at: cached.at };
      usage = await refund(db, { uid, now, limits });
      await Promise.resolve(db.set(`products/${cacheId}`, { ...cached, hits: (cached.hits || 1) + 1, lastHitAt: now })).catch(() => {});
    } else {
      const prompt = prompts.buildPrompt({
        ocrText: ocr, webGuess: guess, secondHand: input.secondHand, focus: input.focus, override: input.override,
        quick: input.quick, photos: images.length, clothes: input.clothes,
      });
      out.gemini = await askGemini(deps, images, prompt, true);
      ai = parseJson(out.gemini.text);
      // Only keep it when Gemini says the barcode is what pinned the product down.
      const matched = ai && (String(ai.barcode || '').replace(/\D/g, '') === barcode || ai.identified_by === 'barcode');
      if (cacheId && matched && (ai.my_new || ai.my_used || ai.cex_my)) {
        const market = Object.fromEntries(Object.entries(ai).filter(([k]) => !prompts.TAG_KEYS.includes(k)));
        await db.set(`products/${cacheId}`, { market: { ...market, barcode }, chunks: out.gemini.chunks, at: now, hits: 1 });
      }
    }
  } catch (e) {
    out.geminiError = e.message.startsWith('Gemini') ? e.message : `Gemini: ${e.message}`;
    usage = await refund(db, { uid, now, limits });
  }

  const query = ai?.search_query || ai?.product_name;
  if (!input.clothes && deps.cexIndex && query) {
    try {
      out.cex = await cexLookup(deps, query);
    } catch (e) {
      out.cexError = e.message; // the app tries CeX again from the phone
    }
  }

  out.status = 'done';
  out.finishedAt = clock();
  out.usage = usage;
  if (jobPath) await db.set(jobPath, { uid, out, expireAt: new Date(now + JOB_TTL) });
  return out;
}

// ---------- asks ----------
// Everything else the app asks Gemini (Worth it, Ask, Translate tag, shelf lists, Compare) or Vision
// (reading a shelf), with its own monthly allowance. It takes any prompt, so it is capped like scans.

const MAX_PROMPT = 12000;

async function reserveAsk(db, { uid, ipHash, now, limits }) {
  return db.txn(async (t) => {
    const day = dayKey(now);
    const month = monthKey(now);
    const user = (await t.get(`users/${uid}`)) || {};
    const counter = (await t.get(`counters/asks-${day}`)) || {};
    const ip = ipHash ? (await t.get(`ipDaily/asks-${day}-${ipHash}`)) || {} : null;
    const limit = user.plan === 'pro' ? limits.proAsks : limits.freeAsks;
    const used = user.asksMonth === month ? user.asksUsed || 0 : 0;
    if (used >= limit) throw new ScanError('resource-exhausted', `No questions left this month (${limit} a month).`, { reason: 'asks', used, limit });
    if ((counter.asks || 0) >= limits.dailyAsks) throw new ScanError('resource-exhausted', 'Kaimono has hit its limit for today. Try again tomorrow.', { reason: 'daily' });
    if (ip && (ip.asks || 0) >= limits.perIp * 3) throw new ScanError('resource-exhausted', 'Too many requests from this connection today.', { reason: 'connection' });
    t.set(`users/${uid}`, { ...user, asksMonth: month, asksUsed: used + 1, updatedAt: now });
    t.set(`counters/asks-${day}`, { asks: (counter.asks || 0) + 1 });
    if (ip) t.set(`ipDaily/asks-${day}-${ipHash}`, { asks: (ip.asks || 0) + 1, expireAt: new Date(now + 2 * DAY) });
    return { used: used + 1, limit };
  });
}

export async function runAsk(input, { uid, ipHash = null, deps }) {
  const { db, limits } = deps;
  const now = (deps.clock || Date.now)();
  const images = Array.isArray(input?.images) ? input.images : [];
  if (images.length > MAX_PHOTOS || !images.every((i) => typeof i === 'string' && i.length > 100 && i.length <= MAX_IMAGE_CHARS)) {
    throw new ScanError('invalid-argument', `Send up to ${MAX_PHOTOS} photos.`);
  }
  const ocrOnly = input?.ocrOnly === true;
  if (ocrOnly ? !images.length : typeof input?.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > MAX_PROMPT) {
    throw new ScanError('invalid-argument', ocrOnly ? 'Send a photo to read.' : 'Missing or overlong question.');
  }
  const asks = await reserveAsk(db, { uid, ipHash, now, limits });
  try {
    const out = ocrOnly ? await readPhotos(deps, images) : await askGemini(deps, images, input.prompt, input.search === true);
    return { ...out, asks };
  } catch (e) {
    await db.txn(async (t) => {
      const user = (await t.get(`users/${uid}`)) || {};
      if (user.asksMonth === monthKey(now) && user.asksUsed > 0) t.set(`users/${uid}`, { ...user, asksUsed: user.asksUsed - 1 });
    });
    throw new ScanError('unavailable', e.message);
  }
}

// The result of a scan whose reply never reached the phone (the app was closed mid-scan).
export async function jobResult(input, { uid, deps }) {
  const jobId = String(input?.jobId || '').replace(/[^\w-]/g, '');
  if (!jobId) throw new ScanError('invalid-argument', 'Missing jobId.');
  const job = await deps.db.get(`jobs/${uid}-${jobId}`);
  return job?.uid === uid ? job.out : { status: 'unknown' };
}
