// Scanning: one photo, several photos, adding a photo later, clothes, and prices in other currencies.
const { test, expect } = require('@playwright/test');
const { mockApis, openApp, product, scan, scanFromGallery, fixture, scanDone, savedHistory } = require('./helpers');

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

test('clothes: photos go to a tray, then one scan with size, and links only to real sources', async ({ page }) => {
  const calls = await mockApis(page, {
    gemini: (prompt) => product({
      product_name: 'Uniqlo Pufftech Parka', currency: 'JPY', price: 4990, cex_my: null,
      clothing: { size_on_tag: 'L', size_my: 'M', material: 'Polyester', colour: 'Olive', product_code: '470077' },
      listings: [{ platform: 'Carousell', condition: 'used', title: 'Uniqlo Pufftech parka 470077 olive', price_rm: 120, exact_model: true, url: 'https://www.carousell.com.my/p/uniqlo-pufftech-123' }],
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
  await expect(page.locator('#searchLinks a')).toHaveText(['Google', 'Carousell']);
  await expect(page.locator('#searchLinks a').nth(1)).toHaveAttribute('href', 'https://www.carousell.com.my/p/uniqlo-pufftech-123');
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

test('a barcode on the tag is searched first and shown on the result', async ({ page }) => {
  const calls = await mockApis(page, {
    vision: () => '中古 ¥3,980 4 902370 548495\n店内 2000123456782',
    gemini: () => product({ barcode: '4902370548495', identified_by: 'barcode' }),
  });
  await openApp(page);
  await scanFromGallery(page);
  const prompt = calls.gemini.at(-1).prompt;
  expect(prompt).toContain('These barcode numbers were found in the text: 4902370548495.');
  expect(prompt).not.toContain('2000123456782.'); // the shop's own stock label isn't offered
  await expect(page.locator('#resIdLine')).toBeVisible();
  await expect(page.locator('#resIdCode')).toHaveText('4902370548495');
});

test('no barcode line when the product was matched by its looks', async ({ page }) => {
  await mockApis(page, { gemini: () => product({ barcode: null, identified_by: 'appearance' }) });
  await openApp(page);
  await scanFromGallery(page);
  await expect(page.locator('#resName')).toHaveText('Sony DualSense Controller');
  await expect(page.locator('#resIdLine')).toBeHidden();
});

test('Gemini briefly overloaded: the scan waits and retries instead of failing', async ({ page }) => {
  const calls = await mockApis(page);
  let busy = 1;
  await page.route('https://generativelanguage.googleapis.com/**', (r) => (busy-- > 0
    ? r.fulfill({ status: 503, json: { error: { message: 'This model is currently experiencing high demand.' } } })
    : r.fallback()));
  await openApp(page);
  await scanFromGallery(page);
  await expect(page.locator('#resName')).toHaveText('Sony DualSense Controller');
  await expect(page.locator('#resError')).toBeHidden();
  expect(calls.gemini).toHaveLength(1); // the one that got through
});

test('CeX: a single-digit model number has to match (Retroid Pocket 6 is not the G2)', async ({ page }) => {
  await mockApis(page, {
    gemini: () => product({ product_name: 'Retroid Pocket 6 Handheld Console', search_query: 'Retroid Pocket 6', price: 1100, currency: 'MYR' }),
    cexHits: [
      { boxId: 'G2', boxName: 'Retroid Pocket G2, C', sellPrice: 630, cashPriceCalculated: 380, exchangePriceCalculated: 450 },
      { boxId: 'RP5', boxName: 'Retroid Pocket 5, B', sellPrice: 1050, cashPriceCalculated: 600, exchangePriceCalculated: 700 },
    ],
  });
  await openApp(page);
  await scanFromGallery(page);
  await expect(page.locator('#resName')).toHaveText('Retroid Pocket 6 Handheld Console');
  await expect(page.locator('#cexSell')).toHaveText('–');
});

test('CeX: the right single-digit model still matches', async ({ page }) => {
  await mockApis(page, {
    gemini: () => product({ product_name: 'Retroid Pocket 6', search_query: 'Retroid Pocket 6' }),
    cexHits: [{ boxId: 'RP6', boxName: 'Retroid Pocket 6 8GB/128GB, B', sellPrice: 1150, cashPriceCalculated: 700, exchangePriceCalculated: 820 }],
  });
  await openApp(page);
  await scanFromGallery(page);
  await expect(page.locator('#cexSell')).toHaveText('RM 1,150');
});

test('CeX: the same model number from another brand is not a match (Xtrfy M4 is not the Aorus M4)', async ({ page }) => {
  await mockApis(page, {
    gemini: () => product({ product_name: 'Xtrfy M4 RGB Ultra-Light Wired Gaming Mouse', search_query: 'Xtrfy M4 RGB wired gaming mouse' }),
    cexHits: [{ boxId: 'A1', boxName: 'Aorus M4 RGB Wired Gaming Mouse, B', sellPrice: 120, cashPriceCalculated: 50, exchangePriceCalculated: 70 }],
  });
  await openApp(page);
  await scanFromGallery(page);
  await expect(page.locator('#cexSell')).toHaveText('–');
});

test('CeX: a row that leaves the brand out, or names a sub-brand too, still matches', async ({ page }) => {
  await mockApis(page, {
    gemini: () => product({ product_name: 'Soundcore Life Q30', search_query: 'Soundcore Life Q30' }),
    cexHits: [{ boxId: 'S1', boxName: 'Soundcore by Anker Life Q30 ANC Headphones, B', sellPrice: 160, cashPriceCalculated: 70, exchangePriceCalculated: 90 }],
  });
  await openApp(page);
  await scanFromGallery(page);
  await expect(page.locator('#cexSell')).toHaveText('RM 160');
});

test('a scan with no prices can be checked again from the result, in any list style', async ({ page }) => {
  let n = 0;
  const calls = await mockApis(page, {
    gemini: () => (++n === 1 ? product({ my_new: null, my_used: null }) : product({ my_new: { typical: 600 } })),
  });
  await openApp(page, { settings: { listStyle: 'grid' } });
  await scanFromGallery(page);
  await expect(page.locator('#verdictLabel')).toContainText('No Malaysian prices found');
  await expect(page.locator('#rescanBtn')).toBeVisible(); // Grid hides ↻ in the list, not here
  await expect(page.locator('#verdictRecheck')).toBeVisible();
  await expect(page.locator('#verdictRecheck')).toHaveText('Check again');
  await page.click('#verdictRecheck');
  await expect(page.locator('#myNew')).toHaveText('RM 600');
  await expect(page.locator('#verdictRecheck')).toBeHidden();
  expect(calls.gemini.length).toBe(2);
});

test('a listing whose link was broken offers a search of that shop instead', async ({ page }) => {
  await mockApis(page);
  await openApp(page, { history: [scan('Gloves', { product_name: 'OMP One Evo-X Racing Gloves', search_query: 'OMP One Evo X gloves', my_new: { typical: 1184 }, listings: [
    { platform: 'Other', condition: 'new', title: 'OMP ONE EVO X RACING GLOVES', price_rm: 1269, url: 'https://www.mikimarketing.com/products/made-up', exact_model: true, link_ok: false },
    { platform: 'Other', condition: 'new', title: 'OMP ONE EVO X RACE GLOVES', price_rm: 1099, url: 'https://lifestylemotorsport.com/p/omp', exact_model: true },
  ] }, { yen: 39700 })] });
  await page.goto('/#/scan/Gloves');
  await page.click('#myNew');
  const items = page.locator('.source-item');
  await expect(items.nth(0)).toContainText('Link was broken.');
  await expect(items.nth(0).locator('a', { hasText: 'Open listing' })).toHaveCount(0);
  const search = items.nth(0).locator('a', { hasText: 'Search mikimarketing.com' });
  expect(decodeURIComponent(await search.getAttribute('href'))).toContain('site:mikimarketing.com OMP One Evo X gloves');
  await expect(items.nth(1).locator('a', { hasText: 'Open listing' })).toHaveAttribute('href', 'https://lifestylemotorsport.com/p/omp');
  await expect(items.nth(1).locator('a', { hasText: 'Search lifestylemotorsport.com' })).toHaveCount(1);
});

test('MY new comes from the listings behind it; a figure with none is shown as a guess and not used', async ({ page }) => {
  await mockApis(page);
  const gloves = { product_name: 'OMP One Evo-X Racing Gloves', my_new: { low: 1600, high: 1950, typical: 1780 } };
  await openApp(page, { history: [
    scan('Listed', { ...gloves, listings: [
      { platform: 'Other', condition: 'new', title: 'OMP One Evo-X Racing Gloves', price_rm: 1099, url: 'https://a.example/1', exact_model: true },
      { platform: 'Other', condition: 'new', title: 'OMP One Evo-X Racing Gloves', price_rm: 1269, url: 'https://b.example/2', exact_model: true },
    ] }, { yen: 39700 }),
    scan('Unlisted', { ...gloves, listings: [] }, { yen: 39700 }),
  ] });
  await page.goto('/#/scan/Listed');
  await expect(page.locator('#myNew')).toHaveText('RM 1,184');
  await expect(page.locator('#myNewRange')).toHaveText('RM 1,099 to RM 1,269');
  await page.goto('/#/scan/Unlisted');
  await expect(page.locator('#myNew')).toHaveText('–');
  await expect(page.locator('#myNewRange')).toHaveText('AI guessed RM 1,780, no listing found');
  await expect(page.locator('#verdictLabel')).toContainText('No Malaysian prices found');
});

test('a broken marketplace link searches that marketplace with a short query', async ({ page }) => {
  await mockApis(page);
  await openApp(page, { history: [scan('Pad', { product_name: 'PS5 DualSense Wireless Controller – Techno Red Edition (CFI-ZCT2J13)', search_query: '', my_new: { typical: 349 }, listings: [
    { platform: 'Shopee', condition: 'new', title: 'PS5 DualSense Wireless Controller – Techno Red Edition (CFI-ZCT2J13)', price_rm: 349, url: 'https://shopee.com.my/made-up-i.1.2', exact_model: true, link_ok: false },
  ] })] });
  await page.goto('/#/scan/Pad');
  await page.click('#myNew');
  const search = page.locator('.source-item a', { hasText: 'Search shopee.com.my' });
  await expect(search).toHaveAttribute('href', 'https://shopee.com.my/search?keyword=PS5%20DualSense%20Wireless%20Controller%20Techno%20Red');
});

test('a busy Gemini gives a plain message and a Try again that works', async ({ page }) => {
  let n = 0;
  await mockApis(page, {
    gemini: (p) => {
      if (p.includes('Their question')) {
        n += 1;
        if (n <= 4) return { status: 503, error: 'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.' };
        return 'Yes, it works with a PC.';
      }
      return product();
    },
  });
  await openApp(page);
  await scanFromGallery(page);
  await page.fill('#askInput', 'Works with PC?');
  await page.click('#askForm button[type="submit"]');
  await expect(page.locator('#qaList .qa-a')).toHaveText("Google's AI is busy right now. Try again in a minute.", { timeout: 20000 });
  await page.click('#qaList .qa-retry');
  await expect(page.locator('#qaList .qa-a')).toHaveText('Yes, it works with a PC.', { timeout: 20000 });
  await expect(page.locator('#qaList li')).toHaveCount(1);
});

test('a listing Gemini says is another model backs no figure; a Shopee listing with no link gets a Shopee search', async ({ page }) => {
  await mockApis(page);
  await openApp(page, { history: [scan('Odin', { product_name: 'AYN Odin 3 Handheld Game Console (Base 8GB+128GB)', search_query: 'AYN Odin 3 8GB 128GB', my_new: { low: 1500, high: 1750, typical: 1600 }, listings: [
    { platform: 'Shopee', condition: 'new', title: 'AYN ODIN3 MAX Qualcomm 8 Elite Handheld', price_rm: 2100, url: null, exact_model: false, match_note: 'Max version with higher specs' },
  ] }, { yen: 1400, currency: 'MYR' })] });
  await page.goto('/#/scan/Odin');
  await expect(page.locator('#myNew')).toHaveText('–');
  await expect(page.locator('#myNewRange')).toHaveText('AI guessed RM 1,600, no exact-model listing');
  await page.click('#myNew');
  await expect(page.locator('.source-item a', { hasText: 'Search Shopee' })).toHaveAttribute('href', 'https://shopee.com.my/search?keyword=AYN%20Odin%203%208GB%20128GB');
});

test('with no price, the price box is in the Need the price card; Gemini\'s own working is not shown', async ({ page }) => {
  await mockApis(page);
  await openApp(page, { history: [scan('Drink', { product_name: 'Kirin Mets Lemon Squash Zero 490ml', variant: 'Zero', variant_evidence: 'label says zero 0 kcal', variant_confidence: 'high' }, { yen: null, currency: 'MYR' })] });
  await page.goto('/#/scan/Drink');
  await expect(page.locator('#verdictLabel')).toHaveText('Need the price');
  await expect(page.locator('#verdict #yenInput')).toBeVisible();
  await expect(page.locator('#shareBtn')).toBeHidden();
  await expect(page.locator('#variantBox')).toBeHidden();
  await page.fill('#yenInput', '5');
  await page.locator('#yenInput').blur();
  await expect(page.locator('#prices #yenInput')).toBeVisible();
  await expect(page.locator('#verdict #yenInput')).toHaveCount(0);
  await expect(page.locator('#yenInput')).toHaveValue('5');
});

test('Find it: with no price, "Just find where to buy it" lists shops (official first, then cheapest) and hides the price check', async ({ page }) => {
  const calls = await mockApis(page, {
    gemini: (p) => (p.includes('Find where to buy') ? {
      shops: [
        { seller: 'Shopee Mall', kind: 'marketplace', title: 'Kirin Mets Lemon Squash Zero 490ml x24', price: 89, currency: 'MYR', price_home: 89, url: 'https://shopee.com.my/kirin-i.1.2' },
        { seller: 'Kirin', kind: 'official', title: 'Mets Lemon Squash Zero', price: 120, currency: 'MYR', price_home: 120, url: 'https://kirin.example/mets' },
        { seller: 'Rakuten', kind: 'overseas', title: 'キリン メッツ レモンスカッシュ', price: 2400, currency: 'JPY', price_home: 70, url: null, ships: 'Ships from Japan, about RM 40' },
        { seller: 'Lookalike shop', kind: 'retailer', title: 'Other lemon soda', price: 5, currency: 'MYR', price_home: 5, exact_model: false },
      ],
      note: 'Cheapest from Japan if you buy a case.',
    } : product()),
  });
  await openApp(page, { history: [scan('Drink', { product_name: 'Kirin Mets Lemon Squash Zero 490ml', brand: 'Kirin' }, { yen: null, currency: 'MYR' })] });
  await page.goto('/#/scan/Drink');
  await page.click('#findBtn');
  await expect(page.locator('#wherePanel')).toBeVisible();
  await expect(page.locator('#whereList .source-platform')).toHaveText(['Kirin', 'Rakuten', 'Shopee Mall']);
  await expect(page.locator('#whereList li').nth(1)).toContainText('Ships from Japan, about RM 40');
  await expect(page.locator('#whereList li').nth(1).locator('a')).toHaveText(['Search Rakuten ↗']);
  await expect(page.locator('#whereNote')).toHaveText('Cheapest from Japan if you buy a case.');
  for (const sel of ['#verdict', '#prices', '#boughtBtn']) await expect(page.locator(sel)).toBeHidden();
  expect(calls.gemini.at(-1).search).toBe(true);
  expect(calls.gemini.at(-1).prompt).toContain('The shopper lives in Malaysia');
  // Back to the price check, and the list stays for next time
  await page.click('#whereExit');
  await expect(page.locator('#verdictLabel')).toHaveText('Need the price');
  await expect(page.locator('#boughtBtn')).toBeVisible();
  await expect(page.locator('#wherePanel')).toBeHidden();
});
