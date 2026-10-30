// Beta tooling: "Right model and prices?", error reports, feedback, the owner's dashboard, install tip.
const { test, expect } = require('@playwright/test');
const { mockApis, openApp, scanFromGallery, scan } = require('./helpers');
const { mockCloud } = require('./cloud');

test.describe('with the backend', () => {
  test.use({ serviceWorkers: 'block' });

  test('Not quite: what was wrong, with the figures judged, goes to the backend and stays on the scan', async ({ page }) => {
    await mockApis(page);
    const cloud = await mockCloud(page);
    await openApp(page, { settings: { apiKey: '' } });
    await scanFromGallery(page);
    await expect(page.locator('#judge')).toBeVisible();
    await page.click('#judgeNo');
    await page.click('#judgeOpts [data-wrong="model"]');
    await page.click('#judgeOpts [data-wrong="used"]');
    await page.fill('#judgeNote', 'It is the Edge');
    await page.click('#judgeSend');
    await expect(page.locator('#judgeDone')).toHaveText('You said: not quite (model, used). Thanks, noted.');
    await expect.poll(() => [...cloud.db.docs.keys()].filter((k) => k.startsWith('feedback/')).length).toBe(1);
    const f = [...cloud.db.docs.entries()].find(([k]) => k.startsWith('feedback/'))[1];
    expect(f).toMatchObject({ verdict: 'wrong', wrong: ['model', 'used'], note: 'It is the Edge', product: { name: 'Sony DualSense Controller', barcode: '4948872415545', market: 'MY', myUsed: 220 } });
    const saved = (await page.evaluate(() => JSON.parse(localStorage.getItem('kc.history'))))[0];
    expect(saved.judged).toMatchObject({ verdict: 'wrong', wrong: ['model', 'used'], sent: true });
    await page.reload();
    await expect(page.locator('#judgeDone')).toBeVisible();
  });

  test('a crash is reported once, with version and device, and kept on the phone', async ({ page }) => {
    await mockApis(page);
    const cloud = await mockCloud(page);
    await openApp(page, { settings: { apiKey: '' } });
    await page.evaluate(() => {
      setTimeout(() => { throw new Error('boom in test'); });
      setTimeout(() => { throw new Error('boom in test'); }, 10);
    });
    await expect.poll(() => [...cloud.db.docs.keys()].filter((k) => k.startsWith('reports/')).length).toBe(1);
    const r = [...cloud.db.docs.entries()].find(([k]) => k.startsWith('reports/'))[1];
    expect(r.message).toContain('boom in test');
    expect(r.version).toMatch(/^2026\./);
    expect(r.device).toContain('Mozilla');
    expect((await page.evaluate(() => JSON.parse(localStorage.getItem('kc.errorLog'))))[0].message).toContain('boom in test');
  });

  test('feedback from Settings, and the owner sees it on the dashboard', async ({ page }) => {
    await mockApis(page);
    await mockCloud(page, { owners: ['anon-1'] });
    await openApp(page, { settings: { apiKey: '' } });
    await scanFromGallery(page);
    await page.click('#judgeYes');
    await page.click('#settingsBtn');
    await page.click('#feedbackBtn');
    await page.fill('#feedbackText', 'Love the CeX check. Add Mercari sold prices?');
    await page.click('#feedbackSend');
    await expect(page.locator('#feedbackMsg')).toHaveText('Sent. Thank you!');
    await page.click('#feedbackClose');
    await page.click('#settingsBtn');
    await expect(page.locator('#statsBtn')).toBeVisible();
    await page.click('#statsBtn');
    await expect(page.locator('#statsBody .stats-grid')).toContainText('Scans today1');
    await expect(page.locator('#statsBody .stats-grid')).toContainText('Accuracy100%');
    await expect(page.locator('#statsBody')).toContainText('Love the CeX check');
    await expect(page.locator('#statsBody')).toContainText('Right: Sony DualSense Controller');
  });

  test('anyone else gets no dashboard', async ({ page }) => {
    await mockApis(page);
    await mockCloud(page, { owners: ['someone-else'] });
    await openApp(page, { settings: { apiKey: '' } });
    await page.click('#settingsBtn');
    await expect(page.locator('#quotaStatus')).toBeVisible();
    await page.waitForTimeout(300);
    await expect(page.locator('#statsBtn')).toBeHidden();
  });
});

test('without the backend, the verdict stays on the scan', async ({ page }) => {
  await mockApis(page);
  await openApp(page, { history: [scan('Deck', { my_new: { typical: 600 } })] });
  await page.goto('/#/scan/Deck');
  await page.click('#judgeYes');
  await expect(page.locator('#judgeDone')).toHaveText('You said this was right. Thanks.');
  expect((await page.evaluate(() => JSON.parse(localStorage.getItem('kc.history'))))[0].judged.verdict).toBe('right');
});

test.describe('on an iPhone in Safari', () => {
  test.use({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });

  test('Home says how to install, until dismissed', async ({ page }) => {
    await mockApis(page);
    await openApp(page, { settings: { installDismissed: false } });
    await expect(page.locator('#installTip')).toBeVisible();
    await expect(page.locator('#installText')).toContainText('Add to Home Screen');
    await page.click('#installClose');
    await page.reload();
    await expect(page.locator('#installTip')).toBeHidden();
  });
});
