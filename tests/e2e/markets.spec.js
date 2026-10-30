// Home country: prices, money, wording and links follow it; earlier scans keep theirs.
const { test, expect } = require('@playwright/test');
const { mockApis, openApp, scan, scanFromGallery, product } = require('./helpers');

test('with Singapore as home, scans search Singapore, show S$ and skip CeX', async ({ page }) => {
  const calls = await mockApis(page, {
    rates: { JPY: 0.0278, 'JPY>SGD': 0.009 },
    gemini: () => product({ my_new: { typical: 129 }, my_used: { typical: 90 } }),
  });
  await openApp(page, { history: [scan('Old', { my_new: { typical: 600 } }, { yen: 10000 })] });
  await page.click('#settingsBtn');
  await page.selectOption('#homeMarketSelect', 'SG');
  await expect(page.locator('#settingsDialog .home-sym').first()).toHaveText('S$');
  await page.click('#saveSettingsBtn');
  await scanFromGallery(page);
  const prompt = calls.gemini.at(-1).prompt;
  expect(prompt).toContain('a shopper from Singapore');
  expect(prompt).toContain('Shopee Singapore (shopee.sg)');
  expect(prompt).toContain('There is no CeX in Singapore: return null for cex_my.');
  expect(prompt).toContain('Power: does it accept 230V?');
  expect(prompt).toContain('are Singapore figures in SGD');
  expect(prompt).not.toContain('Malaysia');
  await expect(page.locator('#jpRm')).toHaveText('S$103');
  await expect(page.locator('#myNewHead')).toHaveText('SG new');
  await expect(page.locator('#myNew')).toHaveText('S$129');
  await expect(page.locator('#shopeeLink')).toHaveAttribute('href', /^https:\/\/shopee\.sg\/search/);
  await expect(page.locator('#carousellLink')).toHaveAttribute('href', /^https:\/\/www\.carousell\.sg\/search\//);
  await expect(page.locator('#cexLink')).toBeHidden();
  expect(calls.cex).toBe(0);
  expect((await page.evaluate(() => JSON.parse(localStorage.getItem('kc.history'))))[0].market).toBe('SG');
  // The scan from before keeps its ringgit and Malaysian wording
  await page.goto('/#/scan/Old');
  await expect(page.locator('#myNewHead')).toHaveText('MY new');
  await expect(page.locator('#myNew')).toHaveText('RM 600');
  await expect(page.locator('#jpRm')).toHaveText('RM 278');
});

test('UK: eBay sold and CeX UK links, pounds, and Malaysia nowhere in the verdict', async ({ page }) => {
  await mockApis(page, { rates: { JPY: 0.0278, 'JPY>GBP': 0.0052 } });
  await openApp(page, { settings: { homeMarket: 'GB', fxFee: 0 }, history: [scan('Deck', { my_new: { typical: 120 }, my_used: { typical: 70 } }, { yen: 10000, market: 'GB' })] });
  await page.goto('/#/scan/Deck');
  await expect(page.locator('#jpRm')).toHaveText('£52.00');
  await expect(page.locator('#dealTags .deal').first()).toHaveText('£18 profit reselling');
  await expect(page.locator('#verdictDetail')).toContainText('in the UK');
  await expect(page.locator('#verdictDetail')).not.toContainText('Malaysia');
  await expect(page.locator('#shopeeLink')).toHaveText('eBay sold');
  await expect(page.locator('#cexLink')).toHaveAttribute('href', /^https:\/\/uk\.webuy\.com\/search/);
  await expect(page.locator('#ratePill')).toHaveText(/^¥1,000 = £5\.20/);
});
