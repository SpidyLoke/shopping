// Background scanning: the real server code (server/Code.gs) runs in a fake Apps Script sandbox and
// answers the app's requests, including the phone closing mid-upload.
const { test, expect } = require('@playwright/test');
const { mockApis, openApp, fixture } = require('./helpers');
const makeServer = require('../server/gas');

const reply = (code, obj) => ({ getResponseCode: () => code, getContentText: () => JSON.stringify(obj) });

function fakeServer(log) {
  return makeServer(require.resolve('../../server/Code.gs'), {
    log,
    fetchImpl: (url) => {
      if (url.startsWith('https://vision')) return reply(200, { responses: [{ fullTextAnnotation: { text: '税込 ¥11,480' } }] });
      if (url.startsWith('https://generativelanguage')) return reply(200, { candidates: [{ content: { parts: [{ text: JSON.stringify({ product_name: 'Sony DualSense Controller', search_query: 'Sony DualSense', price: 11480, currency: 'JPY', my_new: { typical: 329 }, my_used: { typical: 220 } }) }] } }] });
      if (url.startsWith('https://api.telegram.org')) return reply(200, { ok: true, result: {} });
      return reply(200, {});
    },
  });
}

test('a scan finishes on the server even when the phone closes after sending it', async ({ page }) => {
  const calls = await mockApis(page);
  const log = [];
  const server = fakeServer(log);
  let mode = 'closed-after-send';
  const actions = [];
  await page.route('https://script.google.com/**', async (r) => {
    const body = JSON.parse(r.request().postData());
    actions.push(body.action);
    if (body.action === 'scan' && mode === 'lost') return r.abort('failed');
    const out = server.doPost(body);
    if (body.action === 'scan' && mode === 'closed-after-send') return r.abort('failed');
    return r.fulfill({ headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json', body: JSON.stringify(out) });
  });
  await openApp(page, { settings: { serverUrl: 'https://script.google.com/macros/s/TEST/exec', telegram: { token: 't', chatId: 5, bot: 'kaimono_bot' } } });
  await page.setInputFiles('#galleryInput', [fixture('tag.jpg')]);
  await expect(page.locator('#resName')).toHaveText('Sony DualSense Controller', { timeout: 20_000 });
  expect(calls.gemini.length).toBe(0); // Google is called by the server, not the phone
  expect(actions).toEqual(expect.arrayContaining(['scan', 'result']));
  expect(log.some((l) => l.url.includes('api.telegram.org') && l.url.includes('sendMessage'))).toBe(true);

  // the upload never arrives: the app sends it again
  mode = 'lost';
  await page.goto('/#/');
  await page.setInputFiles('#galleryInput', [fixture('tag.jpg')]);
  await page.waitForTimeout(500);
  mode = 'ok';
  await expect(page.locator('#resName')).toHaveText('Sony DualSense Controller', { timeout: 40_000 });
});
