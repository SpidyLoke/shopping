// Kaimono Check scan server (Google Apps Script).
//
// The app hands each scan to this script, which makes the Google Vision, Translate, Gemini and CeX
// calls on Google's side. A phone suspends a web app's network calls as soon as you leave it; this
// keeps going, stores the result for six hours, and pings your phone through ntfy when it's done.
// The app collects the result the next time it's open.
//
// Setup (once): paste this file into a new project at script.google.com, then
// Deploy → New deployment → Web app, Execute as "Me", Who has access "Anyone", and copy the
// Web app URL into the app's Settings. The first request from your app sets a private secret;
// requests without it are refused.

const VERSION = 1;
const RESULT_TTL_SECONDS = 6 * 60 * 60; // CacheService maximum
const CEX_SEARCH = 'https://search.webuy.io/1/indexes/*/queries';

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return reply({ error: 'Bad request' });
  }
  const props = PropertiesService.getScriptProperties();
  const saved = props.getProperty('SECRET');
  if (!req.secret) return reply({ error: 'Missing secret' });
  if (!saved) props.setProperty('SECRET', req.secret); // first caller (your app) claims the server
  else if (saved !== req.secret) return reply({ error: 'This server belongs to another copy of the app' });

  if (req.action === 'ping') {
    if (req.notify && req.notify.topic) ntfy(req.notify.topic, 'Kaimono Check', 'Notifications are working.');
    return reply({ ok: true, version: VERSION });
  }
  if (req.action === 'scan') return reply(runJob(req));
  if (req.action === 'result') return reply(load(req.jobId) || { status: 'unknown' });
  return reply({ error: 'Unknown action' });
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function save(jobId, obj) {
  try {
    CacheService.getScriptCache().put(`job:${jobId}`, JSON.stringify(obj), RESULT_TTL_SECONDS);
  } catch (err) {
    // Over the 100 KB cache limit: drop the bulky parts so the scan still reports in.
    const slim = Object.assign({}, obj, { cex: null, gemini: obj.gemini ? { text: obj.gemini.text, chunks: [] } : null });
    CacheService.getScriptCache().put(`job:${jobId}`, JSON.stringify(slim), RESULT_TTL_SECONDS);
  }
}

function load(jobId) {
  const s = CacheService.getScriptCache().get(`job:${jobId}`);
  return s ? JSON.parse(s) : null;
}

// API keys restricted to the app's website check the Referer header, so send the app's address.
function post(url, body, label, referer, contentType) {
  const options = {
    method: 'post',
    contentType: contentType || 'application/json',
    payload: JSON.stringify(body),
    headers: referer ? { Referer: referer } : {},
    muteHttpExceptions: true,
  };
  let res;
  try {
    res = UrlFetchApp.fetch(url, options);
  } catch (err) {
    if (!referer) throw err;
    // If Apps Script won't send the header, try without it (works with keys that aren't website-restricted).
    options.headers = {};
    res = UrlFetchApp.fetch(url, options);
  }
  const code = res.getResponseCode();
  let data = {};
  try {
    data = JSON.parse(res.getContentText());
  } catch (err) {
    // non-JSON body
  }
  if (code >= 400) throw new Error(`${label}: ${(data.error && data.error.message) || `HTTP ${code}`}`);
  return data;
}

function parseJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  return start === -1 || end <= start ? null : JSON.parse(body.slice(start, end + 1));
}

function runJob(req) {
  const out = { status: 'running', startedAt: Date.now() };
  save(req.jobId, out);
  const keys = req.keys || {};
  const referer = req.referer || '';
  let ocr = req.ocrText || '';
  let guess = req.webGuess || '';

  if (req.vision) {
    try {
      const d = post(`https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(keys.cloud)}`, {
        requests: [{
          image: { content: req.image },
          features: [{ type: 'DOCUMENT_TEXT_DETECTION' }, { type: 'WEB_DETECTION', maxResults: 5 }],
          imageContext: { languageHints: ['ja', 'en'] },
        }],
      }, 'Vision', referer);
      const r = (d.responses || [])[0] || {};
      if (r.error) throw new Error(`Vision: ${r.error.message}`);
      ocr = ((r.fullTextAnnotation || {}).text || '').trim();
      guess = (((r.webDetection || {}).bestGuessLabels || [])[0] || {}).label || '';
      out.vision = { ocrText: ocr, webGuess: guess };
    } catch (err) {
      out.visionError = err.message;
    }
  }

  if (req.translate && ocr) {
    try {
      const d = post(`https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(keys.cloud)}`,
        { q: ocr, target: 'en', format: 'text' }, 'Translate', referer);
      const t = ((d.data || {}).translations || [])[0] || {};
      out.translate = { translation: t.translatedText || '', sourceLang: t.detectedSourceLanguage || '' };
    } catch (err) {
      out.translateError = err.message;
    }
  }

  let ai = null;
  if (req.prompt) {
    try {
      const prompt = req.prompt.split('{{OCR}}').join(ocr || '(none detected)').split('{{WEBGUESS}}').join(guess || 'none');
      const parts = [];
      if (req.image) parts.push({ inline_data: { mime_type: 'image/jpeg', data: req.image } });
      parts.push({ text: prompt });
      const body = { contents: [{ role: 'user', parts }] };
      if (req.search !== false) body.tools = [{ google_search: {} }];
      const d = post(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(req.model)}:generateContent?key=${encodeURIComponent(keys.gemini || keys.cloud)}`,
        body, 'Gemini', referer);
      const cand = (d.candidates || [])[0] || {};
      const text = ((cand.content || {}).parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
      if (!text) throw new Error(`Gemini returned no answer (${cand.finishReason || (d.promptFeedback || {}).blockReason || 'no reason given'}).`);
      const chunks = ((cand.groundingMetadata || {}).groundingChunks || [])
        .map((c) => c.web).filter(Boolean).map((w) => ({ title: w.title || w.uri, uri: w.uri }));
      out.gemini = { text, chunks };
      ai = parseJson(text);
    } catch (err) {
      out.geminiError = err.message.indexOf('Gemini') === 0 ? err.message : `Gemini: ${err.message}`;
    }
  }

  const query = ai && (ai.search_query || ai.product_name);
  if (req.cex && query) {
    try {
      const params = `query=${encodeURIComponent(query)}&hitsPerPage=30&filters=${encodeURIComponent('boxVisibilityOnWeb=1')}`;
      const d = post(CEX_SEARCH, { requests: [{ indexName: req.cex.index, params }] }, 'CeX', '', 'application/x-www-form-urlencoded');
      const hits = (((d.results || [])[0] || {}).hits || []).map((h) => ({
        boxId: h.boxId,
        boxName: h.boxName,
        sellPrice: h.sellPrice,
        cashPriceCalculated: h.cashPriceCalculated,
        exchangePriceCalculated: h.exchangePriceCalculated,
      }));
      out.cex = { query, hits };
    } catch (err) {
      out.cexError = err.message;
    }
  }

  out.status = 'done';
  out.finishedAt = Date.now();
  save(req.jobId, out);

  if (req.notify && req.notify.topic) {
    const name = (ai && ai.product_name) || 'Your scan';
    const price = ai && ai.jp_price_yen ? ` · ¥${Number(ai.jp_price_yen).toLocaleString('en-GB')}` : '';
    const failed = out.geminiError ? ' (price check failed, tap ↻ in the app)' : '';
    try {
      ntfy(req.notify.topic, 'Scan ready', `${name}${price}${failed}. Open Kaimono Check to see if it's worth it.`);
    } catch (err) {
      // the result is saved either way
    }
  }
  return out;
}

// ntfy.sh: free push notifications. JSON publishing keeps non-ASCII titles intact.
function ntfy(topic, title, message) {
  UrlFetchApp.fetch('https://ntfy.sh/', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ topic, title, message, tags: ['shopping_cart'] }),
    muteHttpExceptions: true,
  });
}
