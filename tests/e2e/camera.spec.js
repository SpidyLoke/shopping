// Built-in camera (Chromium's fake camera stands in for the phone's).
const { test, expect } = require('@playwright/test');
const { mockApis, openApp, scanDone } = require('./helpers');

const cameraReady = (page) => page.waitForFunction(() => document.querySelector('#camVideo').videoWidth > 0);

test('item: the shutter scans straight away', async ({ page }) => {
  const calls = await mockApis(page);
  await openApp(page, { settings: { liveCamera: true } });
  await page.click('.capture');
  await expect(page.locator('#cameraView')).toHaveAttribute('open', '');
  await cameraReady(page);
  await page.click('#camShutter');
  await scanDone(page);
  await expect(page.locator('#cameraView')).not.toHaveAttribute('open', '');
  expect(calls.gemini.at(-1).images).toBe(1);
});

test('clothes: several shots, then Check', async ({ page }) => {
  const calls = await mockApis(page);
  await openApp(page, { settings: { liveCamera: true, scanKind: 'clothes' } });
  await page.click('.capture');
  await cameraReady(page);
  await page.click('#camShutter');
  await expect(page.locator('#camDone')).toHaveText('Check · 1');
  await page.click('#camShutter');
  await page.click('#camDone');
  await scanDone(page);
  expect(calls.gemini.at(-1).images).toBe(2);
});

test('reopening the camera reuses it instead of asking for permission again', async ({ page }) => {
  await mockApis(page);
  await openApp(page, { settings: { liveCamera: true } });
  await page.evaluate(() => {
    window.__asked = 0;
    const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (c) => { window.__asked += 1; return real(c); };
  });
  for (let i = 0; i < 3; i += 1) {
    await page.click('.capture');
    await cameraReady(page);
    await page.click('#camClose');
  }
  expect(await page.evaluate(() => window.__asked)).toBe(1);
});

test('with the built-in camera off, the iPhone camera picker opens', async ({ page }) => {
  await mockApis(page);
  await openApp(page);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.capture')]);
  expect(chooser).toBeTruthy();
  await expect(page.locator('#cameraView')).not.toHaveAttribute('open', '');
});
