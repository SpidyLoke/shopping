// Compare: side by side, and "Which should I get?".
const { test, expect } = require('@playwright/test');
const { mockApis, openApp, scan } = require('./helpers');

test('Which should I get? picks one, marks it and remembers', async ({ page }) => {
  const calls = await mockApis(page, {
    gemini: () => ({
      pick: 2, headline: 'The iPhone card if you use an iPhone, the E40 if Android', reason: 'Find My vs Find Hub.',
      depends_on: 'iPhone or Android?', differences: [{ aspect: 'Works with', values: ['Android', 'iPhone'] }], best_for: ['Android users', 'iPhone users'],
    }),
  });
  await openApp(page, { history: [scan('a1', { product_name: 'Eufy E40' }, { yen: 5990 }), scan('b2', { product_name: 'Eufy iPhone card' }, { yen: 3810 })] });
  await page.goto('/#/compare/a1,b2');
  await page.fill('#pickNeed', 'I use an iPhone');
  await page.click('#pickBtn');
  await expect(page.locator('.pick-winner')).toHaveText('Pick: Eufy iPhone card');
  await expect(page.locator('.cmp-item.picked')).toContainText('Eufy iPhone card');
  expect(calls.gemini[0].prompt).toContain('I use an iPhone');
  expect(calls.gemini[0].images).toBe(2);
  // reopened the other way round: same pick, same order
  await page.goto('/#/history');
  await page.goto('/#/compare/b2,a1');
  await expect(page.locator('.pick-winner')).toHaveText('Pick: Eufy iPhone card');
  await expect(page.locator('#pickBtn')).toHaveText('Ask again');
});
