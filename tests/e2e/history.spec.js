// History: long-press menu, swipes, Undo, filter chips, list styles, Back and pull to refresh.
const { test, expect } = require('@playwright/test');
const { mockApis, openApp, scan, savedHistory, product } = require('./helpers');

const HISTORY = [
  scan('Alpha', { my_new: { typical: 329 } }),
  scan('Beta', { my_new: { typical: 329 } }, { fav: true, secondHand: true }),
  scan('Gamma', { my_new: { typical: 329 } }),
];
const flags = async (page) => Object.fromEntries((await savedHistory(page)).map((e) => [e.id, `${e.fav ? 'fav' : ''}${e.bought ? 'bought' : ''}`]));
const row = (page, name) => page.locator('#historyList .swipe', { hasText: name }).locator('.history-row');

async function drag(page, locator, fromX, toX) {
  const box = await locator.boundingBox();
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + fromX, y);
  await page.mouse.down();
  await page.mouse.move(box.x + toX, y, { steps: 8 });
  await page.mouse.up();
}

test.beforeEach(async ({ page }) => {
  await mockApis(page);
  await openApp(page, { history: HISTORY, hash: '#/history' });
});

test('long-press opens quick actions; Mark as bought can be undone', async ({ page }) => {
  const box = await row(page, 'Alpha').boundingBox();
  await page.mouse.move(box.x + 150, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.mouse.up();
  await expect(page.locator('#rowMenu')).toHaveAttribute('open', '');
  await expect(page.locator('#menuName')).toHaveText('Alpha');
  await expect(page).toHaveURL(/#\/history/);
  await page.click('#menuBought');
  expect((await flags(page)).Alpha).toBe('bought');
  await page.click('#undoBtn');
  expect((await flags(page)).Alpha).toBe('');
});

test('swipe right favourites, swipe left deletes (with Undo)', async ({ page }) => {
  await drag(page, row(page, 'Gamma'), 60, 220);
  expect((await flags(page)).Gamma).toBe('fav');
  await expect(page.locator('#undoText')).toHaveText('Added to favourites');
  await drag(page, row(page, 'Alpha'), 300, 30);
  await expect(page.locator('#undoText')).toHaveText('Deleted Alpha');
  expect(Object.keys(await flags(page))).not.toContain('Alpha');
  await page.click('#undoBtn');
  expect(Object.keys(await flags(page))).toContain('Alpha');
});

test('filter chips narrow the list', async ({ page }) => {
  await page.click('#historyChips button:has-text("Used")');
  await expect(page.locator('#historyList .history-name')).toHaveText(['Beta']);
});

test('list styles switch from Settings', async ({ page }) => {
  await page.click('#settingsBtn');
  await page.click('[data-setting="listStyle"] [data-value="grid"]');
  await expect(page.locator('html')).toHaveAttribute('data-list', 'grid');
  await page.click('[data-setting="theme"] [data-value="dark"]');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.click('[data-setting="accent"] [data-value="green"]');
  expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--accent-bg'))).toBe('#2a8a5c');
});

test('Back returns to where a scan was opened from; edge swipe does the same', async ({ page }) => {
  await page.click('#historyList .swipe:first-child .history-item');
  await expect(page).toHaveURL(/#\/scan\//);
  await expect(page.locator('#backBtn')).toBeVisible();
  await page.click('#backBtn');
  await expect(page).toHaveURL(/#\/history/);
  await page.click('#historyList .swipe:first-child .history-item');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 6, y: 400 }] });
  for (const x of [40, 90, 150]) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: 402 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(page).toHaveURL(/#\/history/);
});

test('pull down on a scan re-checks it', async ({ page }) => {
  const calls = await mockApis(page, { gemini: () => product({ product_name: 'Rechecked' }) });
  await page.click('#historyList .swipe:first-child .history-item');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 200, y: 150 }] });
  for (const y of [180, 260, 330]) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 200, y }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(page.locator('#resName')).toHaveText('Rechecked');
  expect(calls.gemini.length).toBe(1);
});
