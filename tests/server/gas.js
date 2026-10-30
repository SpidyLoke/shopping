// Loads server/Code.gs into a sandbox with fake Apps Script services.
const vm = require('vm');
const fs = require('fs');
module.exports = function makeServer(codePath, { fetchImpl, log = [] } = {}) {
  const cache = new Map(); const props = new Map();
  const ctx = {
    console,
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props.get(k) ?? null, setProperty: (k, v) => props.set(k, v) }) },
    CacheService: { getScriptCache: () => ({ put: (k, v) => { if (v.length > 100000) throw new Error('Argument too large'); cache.set(k, v); }, get: (k) => cache.get(k) ?? null }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (t) => ({ setMimeType: () => ({ text: t }) }) },
    Utilities: { sleep: (ms) => { (ctx.__slept ||= []).push(ms); } },
    UrlFetchApp: { fetch: (url, opt) => { log.push({ url, opt }); return fetchImpl(url, opt); } },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(codePath, 'utf8'), ctx);
  return { ctx, doPost: (body) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).text), cache, props, log };
};
