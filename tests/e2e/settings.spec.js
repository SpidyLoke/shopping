// Settings: no password prompts, saved keys kept, backup and restore.
const { test, expect } = require('@playwright/test');
const { mockApis, openApp, scan } = require('./helpers');

test('no form or password field (iPhone would offer to save a password)', async ({ page }) => {
  await mockApis(page);
  await openApp(page);
  await page.click('#settingsBtn');
  await expect(page.locator('#settingsDialog form')).toHaveCount(0);
  await expect(page.locator('#settingsDialog input[type="password"]')).toHaveCount(0);
});

test('saved keys are never refilled and an empty box keeps them', async ({ page }) => {
  await mockApis(page);
  await openApp(page);
  await page.click('#settingsBtn');
  await page.click('#keysGroup summary');
  await page.fill('#apiKeyInput', 'AIzaCLOUD1234');
  await page.fill('#geminiKeyInput', 'AIzaGEMINI9999');
  await page.click('#saveSettingsBtn');
  await page.click('#settingsBtn');
  await expect(page.locator('#apiKeyInput')).toHaveValue('');
  await expect(page.locator('#apiKeyInput')).toHaveAttribute('placeholder', 'Saved · AIza…1234');
  await page.click('#saveSettingsBtn');
  expect(await page.evaluate(() => [localStorage.getItem('kc.apiKey'), localStorage.getItem('kc.geminiKey')])).toEqual(['"AIzaCLOUD1234"', '"AIzaGEMINI9999"']);
});

test('backup then restore into a fresh install brings back scans, photos and keys', async ({ page, browser }, testInfo) => {
  await mockApis(page);
  await openApp(page, { history: [scan('Kept', {}, { extra: [{ id: 'Kept-p2', thumb: 'data:,' }] })] });
  await page.evaluate(async () => {
    const db = await new Promise((res) => { const r = indexedDB.open('kaimono', 1); r.onupgradeneeded = () => r.result.createObjectStore('images'); r.onsuccess = () => res(r.result); });
    await new Promise((res) => { const t = db.transaction('images', 'readwrite'); t.objectStore('images').put('MAIN', 'Kept'); t.objectStore('images').put('LABEL', 'Kept-p2'); t.oncomplete = res; });
  });
  await page.click('#settingsBtn');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#backupBtn')]);
  const file = testInfo.outputPath('backup.json');
  await download.saveAs(file);

  const fresh = await (await browser.newContext()).newPage();
  await mockApis(fresh);
  fresh.on('dialog', (d) => d.accept());
  await fresh.goto('/');
  await fresh.click('#settingsBtn');
  await Promise.all([fresh.waitForNavigation(), fresh.setInputFiles('#restoreInput', file)]);
  const restored = await fresh.evaluate(async () => {
    const db = await new Promise((res) => { const r = indexedDB.open('kaimono', 1); r.onsuccess = () => res(r.result); });
    const get = (k) => new Promise((res) => { const r = db.transaction('images').objectStore('images').get(k); r.onsuccess = () => res(r.result); });
    return { scans: JSON.parse(localStorage.getItem('kc.history')).length, key: localStorage.getItem('kc.apiKey'), main: await get('Kept'), label: await get('Kept-p2') };
  });
  expect(restored).toEqual({ scans: 1, key: '"K"', main: 'MAIN', label: 'LABEL' });
});
