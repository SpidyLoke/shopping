// Scanning with a Kaimono account: no API keys on the phone, a monthly allowance, the barcode cache.
const { test, expect } = require('@playwright/test');
const { mockApis, openApp, scanFromGallery, product } = require('./helpers');
const { mockCloud } = require('./cloud');

// The service worker would fetch firebase-config.js itself, past the stubs.
test.use({ serviceWorkers: 'block' });

test('with no keys, a scan goes through the Kaimono backend and counts against the allowance', async ({ page }) => {
  const google = await mockApis(page);
  const cloud = await mockCloud(page);
  await openApp(page, { settings: { apiKey: '' } });
  await expect(page.locator('#keyNotice')).toBeHidden();
  await scanFromGallery(page);
  await expect(page.locator('#resName')).toHaveText('Sony DualSense Controller');
  await expect(page.locator('#jpRm')).toHaveText('RM 319');
  await expect(page.locator('#resIdCode')).toHaveText('4948872415545');
  expect(google.gemini).toHaveLength(0); // nothing from the phone to Google with a key
  expect(google.vision).toHaveLength(0);
  expect(cloud.calls.scan).toHaveLength(1);
  expect(cloud.calls.scan[0]).toMatchObject({ secondHand: false, clothes: false });
  expect([...cloud.calls.regions]).toEqual(['asia-southeast1']);
  expect(cloud.calls.gemini[0].prompt).toContain('These barcode numbers were found in the text: 4948872415545');
  await page.goto('/#/');
  await expect(page.locator('#quotaLine')).toHaveText(/^9 of 10 scans left this month · resets 1 Nov$/);
});

test('a barcode scanned before is free and says so', async ({ page }) => {
  await mockApis(page);
  const cloud = await mockCloud(page);
  await openApp(page, { settings: { apiKey: '' } });
  await scanFromGallery(page);
  await scanFromGallery(page);
  expect(cloud.calls.gemini.map((g) => g.search)).toEqual([true, false]);
  await expect(page.locator('#serverInfo')).toContainText('so this one was free');
  await page.goto('/#/');
  await expect(page.locator('#quotaLine')).toHaveText(/^9 of 10 scans left/);
});

test('when the allowance runs out the scan says so instead of retrying', async ({ page }) => {
  await mockApis(page);
  const cloud = await mockCloud(page, { ocr: '¥3,000', limits: { free: 1 } });
  await openApp(page, { settings: { apiKey: '' } });
  await scanFromGallery(page);
  await scanFromGallery(page);
  await expect(page.locator('#resError')).toContainText('No scans left this month (1 a month on the free plan).');
  expect(cloud.calls.scan).toHaveLength(2);
  await page.goto('/#/');
  await expect(page.locator('#quotaLine')).toHaveText(/^0 of 1 scan left/);
});

test('Worth it and questions use the backend too; Settings can switch to your own keys', async ({ page }) => {
  const google = await mockApis(page);
  const cloud = await mockCloud(page, { gemini: (p) => (p.includes('Reply with only a JSON object') && !p.includes('verdict') ? product() : 'It is a fair price.') });
  await openApp(page, { settings: { apiKey: '' } });
  await scanFromGallery(page);
  await page.fill('#askInput', 'Is the battery replaceable?');
  await page.click('#askForm button[type="submit"]');
  await expect(page.locator('#qaList')).toContainText('It is a fair price.');
  expect(cloud.calls.ask.at(-1).prompt).toContain('Is the battery replaceable?');
  // Switch to own keys: the next question goes straight to Google
  await page.click('#settingsBtn');
  await expect(page.locator('#scanWithGroup')).toBeVisible();
  await expect(page.locator('#quotaStatus')).toHaveText(/scans left this month/);
  await expect(page.locator('#accountId')).toHaveText('Account ID anon-1');
  await page.click('[data-setting="scanWith"] [data-value="keys"]');
  await expect(page.locator('#quotaStatus')).toHaveText(/your own Google keys/);
  await page.evaluate(() => localStorage.setItem('kc.apiKey', '"K"'));
  await page.click('#saveSettingsBtn');
  await page.fill('#askInput', 'And the charger?');
  await page.click('#askForm button[type="submit"]');
  await expect.poll(() => google.gemini.length).toBe(1);
});

test('a scan whose reply was lost is collected from the backend, not run (or charged) twice', async ({ page }) => {
  await mockApis(page);
  const cloud = await mockCloud(page, { dropReplies: 1 });
  await openApp(page, { settings: { apiKey: '' } });
  await scanFromGallery(page);
  await expect(page.locator('#resName')).toHaveText('Sony DualSense Controller');
  expect(cloud.calls.scan).toHaveLength(1);
  expect(cloud.calls.result).toBeGreaterThan(0);
  expect(cloud.db.docs.get('users/anon-1').used).toBe(1);
});
