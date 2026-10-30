// Deal labels and row badges, and clothes that only match similar pieces.
const { test, expect } = require('@playwright/test');
const { mockApis, openApp, scan } = require('./helpers');

// ¥10,000 at 0.03 = RM 300 here.
const at300 = (id, ai, cex) => scan(id, { ...ai, cex_my: cex ? { sell_rm: cex[0], buy_cash_rm: cex[1] } : null }, { yen: 10000 });
const CASES = [
  [at300('a', { my_used: { typical: 450 }, my_new: { typical: 600 } }, [500, 350]), 'CeX pays RM 50 more', 'CeX +RM 50'],
  [at300('bb', { my_used: { typical: 350 }, my_new: { typical: 600 } }, [400, 200]), 'Resells for RM 50 more', 'Resell +RM 50'],
  [at300('ccc', { my_used: { typical: 380 }, my_new: { typical: 600 } }, [280, 150]), 'Resells for RM 80 more', 'Resell +RM 80'],
  [at300('dddd', { my_used: { typical: 250 }, my_new: { typical: 400 } }), 'RM 100 under MY new', 'RM 100 off new'],
  [at300('eeeee', { my_new: { typical: 250 } }), 'RM 50 over MY new', 'Dearer here'],
  [at300('ffffff', { my_used: { typical: 500 }, my_new: { typical: 600 }, my_compat: [{ topic: 'Power', status: 'bad', note: '100V only' }] }), null, 'Power issue'],
];

test('the deal label says where the price sits, and row badges carry it', async ({ page }) => {
  await mockApis(page, { rates: { JPY: 0.03 } });
  await openApp(page, { history: CASES.map(([e]) => e), hash: '#/history' });
  for (const [e, label] of CASES) {
    if (!label) continue;
    await page.goto(`/#/scan/${e.id}`);
    await expect(page.locator('#dealTags .deal').first()).toHaveText(label);
  }
  await page.goto('/#/history');
  for (const [e, , badge] of CASES) {
    const row = page.locator('#historyList .history-item', { hasText: e.ai.product_name }).first();
    await expect(row.locator('.tag')).toHaveText(badge);
  }
  // the second label shows under the price
  await expect(page.locator('#historyList .history-item', { hasText: 'ccc' }).locator('.history-deal')).toHaveText('RM 20 over CeX');
  // Resale profit chip leaves out the 100V item
  await page.click('#historyChips button:has-text("Resale profit")');
  await expect(page.locator('#historyList .history-name')).toHaveText(['a', 'bb', 'ccc']);
});

test('clothes priced only from a different design say No exact match', async ({ page }) => {
  await mockApis(page);
  const jacket = (id, listing) => scan(id, {
    product_name: 'adidas Originals MA-1 Superstar Bomber Jacket', my_used: { typical: 145 }, my_new: { typical: 450 },
    clothing: { product_code: 'AY9150', colour: 'Navy' }, listings: [listing],
  }, { kind: 'clothes', yen: 7000, secondHand: true });
  await openApp(page, { history: [
    jacket('wrong', { platform: 'Carousell', condition: 'used', title: 'Adidas ma1 bomber jacket', price_rm: 145, exact_model: true, sold: true }),
    jacket('right', { platform: 'Carousell', condition: 'used', title: 'adidas MA-1 Superstar AY9150 navy', price_rm: 160, exact_model: true }),
  ] });
  await page.goto('/#/scan/wrong');
  await expect(page.locator('#verdictLabel')).toHaveText('No exact match');
  await expect(page.locator('#myUsedSrc')).toHaveText('Similar items only ›');
  await page.click('#myUsed');
  await expect(page.locator('.source-item .tag')).toHaveText(['Similar item', 'Sold']);
  await page.click('#sourceClose');
  await page.goto('/#/scan/right');
  await expect(page.locator('#verdictLabel')).not.toHaveText('No exact match');
  await expect(page.locator('#myUsedSrc')).toHaveText('1 listing ›');
});
