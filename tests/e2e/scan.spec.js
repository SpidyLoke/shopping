// Scanning: one photo, several photos, adding a photo later, clothes, and prices in other currencies.
const { test, expect } = require('@playwright/test');
const { mockApis, openApp, product, scanFromGallery, fixture, scanDone, savedHistory } = require('./helpers');

test('a Japanese tag gets RM prices, a verdict and CeX', async ({ page }) => {
  const calls = await mockApis(page, {
    gemini: () => product({ my_new: { typical: 329 }, my_used: { typical: 220 }, listings: [
      { platform: 'Shopee', condition: 'new', title: 'Sony DualSense Controller PS5', price_rm: 329, url: 'https://shopee.com.my/x', exact_model: true },
    ] }),
    cexHits: [{ boxId: 'D1', boxName: 'Sony DualSense Wireless Controller - White, B', sellPrice: 199, cashPriceCalculated: 90, exchangePriceCalculated: 120 }],
  });
  await openApp(page);
  await scanFromGallery(page);
  await expect(page.locator('#resName')).toHaveText('Sony DualSense Controller');
  await expect(page.locator('#jpRm')).toHaveText('RM 319');
  await expect(page.locator('#myNew')).toHaveText('RM 329');
  await expect(page.locator('#cexSell')).toHaveText('RM 199');
  await expect(page.locator('#verdictLabel')).toHaveText('Marginal');
  expect(calls.gemini[0].search).toBe(true);
  expect(calls.cex).toBeGreaterThan(0);
  // Where MY new comes from
  await page.click('#myNew');
  await expect(page.locator('#sourceSheet')).toHaveAttribute('open', '');
  await expect(page.locator('.source-item')).toContainText(['Same model']);
});

test('several photos from the library are one scan, read together', async ({ page }) => {
  const calls = await mockApis(page);
  await openApp(page);
  await scanFromGallery(page, ['tag.jpg', 'shelf.jpg']);
  expect(calls.vision.at(-1)).toBe(2);
  expect(calls.gemini.at(-1).images).toBe(2);
  expect(calls.gemini.at(-1).prompt).toContain('The 2 attached photos all show the same item');
  await expect(page.locator('#photoCount')).toHaveText('+1');
  // swipe between them in the viewer
  await page.click('#resPhotoBtn');
  await expect(page.locator('#viewerCount')).toHaveText('1 / 2');
  const box = await page.locator('#viewerStage').boundingBox();
  await page.mouse.move(box.x + 300, box.y + 400);
  await page.mouse.down();
  await page.mouse.move(box.x + 80, box.y + 405, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator('#viewerCount')).toHaveText('2 / 2');
});

test('Add photo rescans with it, and Undo goes back', async ({ page }) => {
  let n = 0;
  const calls = await mockApis(page, { gemini: () => product({ product_name: n++ === 0 ? 'First read' : 'Second read' }) });
  await openApp(page);
  await scanFromGallery(page);
  await expect(page.locator('#resName')).toHaveText('First read');
  await page.setInputFiles('#addPhotoInput', [fixture('shelf.jpg')]);
  await expect(page.locator('#resName')).toHaveText('Second read');
  expect(calls.gemini.at(-1).images).toBe(2);
  await expect(page.locator('#undoText')).toHaveText('Scan updated');
  await page.click('#undoBtn');
  await expect(page.locator('#resName')).toHaveText('First read');
  await expect(page.locator('#photoCount')).toBeHidden();
});

test('clothes: photos go to a tray, then one scan with size and Zalora', async ({ page }) => {
  const calls = await mockApis(page, {
    gemini: (prompt) => product({
      product_name: 'Uniqlo Pufftech Parka', currency: 'JPY', price: 4990, cex_my: null,
      clothing: { size_on_tag: 'L', size_my: 'M', material: 'Polyester', colour: 'Olive', product_code: '470077' },
      listings: [{ platform: 'Carousell', condition: 'used', title: 'Uniqlo Pufftech parka 470077 olive', price_rm: 120, exact_model: true }],
      my_used: { typical: 120 }, my_new: { typical: 249 },
      _clothes: prompt.includes('CLOTHES:'),
    }),
  });
  await openApp(page);
  await page.click('[data-kind="clothes"]');
  await expect(page.locator('#captureLabel')).toHaveText('Photograph the piece');
  await page.setInputFiles('#cameraInput', [fixture('tag.jpg')]);
  await expect(page.locator('#photoTray')).toHaveAttribute('open', '');
  await page.setInputFiles('#trayCamera', [fixture('shelf.jpg')]);
  await expect(page.locator('#trayGo')).toHaveText('Check price · 2 photos');
  await page.click('#trayGo');
  await scanDone(page);
  expect(calls.gemini.at(-1).prompt).toContain('CLOTHES:');
  expect(calls.gemini.at(-1).images).toBe(2);
  expect(calls.cex).toBe(0);
  await expect(page.locator('#resTime')).toHaveText('Size L (≈ MY M) · Polyester · Olive');
  await expect(page.locator('#cexLink')).toHaveText('Zalora');
  expect((await savedHistory(page))[0].kind).toBe('clothes');
});

test('a Malaysian listing is judged as a local price', async ({ page }) => {
  await mockApis(page, { vision: () => 'RM1,000', gemini: () => product({ product_name: 'Retroid Pocket 6', price: 1000, currency: 'MYR', my_new: { typical: 1199 }, my_used: { typical: 950 } }) });
  await openApp(page);
  await scanFromGallery(page);
  await expect(page.locator('#jpHead')).toHaveText('Asking price');
  await expect(page.locator('#currencySymbol')).toHaveText('RM');
  await expect(page.locator('#jpRm')).toBeHidden();
  await expect(page.locator('#taxInclToggle')).toBeHidden();
  await expect(page.locator('#verdictLabel')).toHaveText('Good price for new');
  await expect(page.locator('#verdictDetail')).toContainText('elsewhere in Malaysia');
});

test('other currencies convert at their own rate, and can be changed by hand', async ({ page }) => {
  const calls = await mockApis(page, { vision: () => '$449.99', gemini: () => product({ product_name: 'Switch 2', price: 449.99, currency: 'USD', my_new: { typical: 2199 } }) });
  await openApp(page);
  await scanFromGallery(page);
  await expect(page.locator('#jpHead')).toHaveText('Price in USD');
  await expect(page.locator('#jpRm')).toHaveText('RM 1,980');
  await page.selectOption('#currencySelect', 'SGD');
  await expect(page.locator('#jpRm')).toHaveText('RM 1,485');
  expect(calls.rates).toEqual(expect.arrayContaining(['USD', 'SGD']));
});
