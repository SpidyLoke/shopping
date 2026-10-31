// Close-the-app scanning: notifications when a scan is ready, and a backend that can't be reached
// showing up as an error instead of an endless "Sending…".
const { test, expect } = require('@playwright/test');
const { mockApis, openApp, fixture } = require('./helpers');
const { mockCloud } = require('./cloud');

// Push needs a real browser push service; stand in for the browser's half of it.
const fakePush = () => {
  let permission = 'default';
  window.Notification = { get permission() { return permission; }, requestPermission: async () => { permission = 'granted'; return 'granted'; } };
  window.PushManager = function PushManager() {};
  const sub = { toJSON: () => ({ endpoint: 'https://web.push.apple.com/QTest', keys: { p256dh: 'B'.repeat(40), auth: 'a'.repeat(22) } }), unsubscribe: async () => true };
  let subscribed = null;
  const reg = {
    pushManager: { getSubscription: async () => subscribed, subscribe: async (o) => { window.__subscribeOptions = o; subscribed = sub; return sub; } },
    getNotifications: async () => [],
  };
  Object.defineProperty(navigator, 'serviceWorker', { value: { ready: Promise.resolve(reg), getRegistration: async () => reg, register: async () => reg }, configurable: true });
};

test('turn on notifications, then a scan tells the backend to notify when it is ready', async ({ page }) => {
  await page.addInitScript(fakePush);
  await mockApis(page);
  const cloud = await mockCloud(page);
  await openApp(page, { settings: { apiKey: '' } });
  await page.click('#settingsBtn');
  await expect(page.locator('#notifyRow')).toBeVisible();
  await page.click('#notifyRow');
  await expect(page.locator('#notifyToggle')).toBeChecked();
  expect(cloud.db.docs.get('users/anon-1').push.endpoint).toBe('https://web.push.apple.com/QTest');
  expect(await page.evaluate(() => window.__subscribeOptions.userVisibleOnly)).toBe(true);
  await page.click('#saveSettingsBtn');
  await page.goto('/#/');
  await page.setInputFiles('#galleryInput', fixture('tag.jpg'));
  await expect(page.locator('#resName')).toHaveText('Sony DualSense Controller');
  expect(cloud.calls.scan[0]).toMatchObject({ notify: true });
  expect(cloud.calls.pushes).toHaveLength(1);
  expect(cloud.calls.pushes[0].payload).toMatchObject({ title: 'Scan ready', url: expect.stringMatching(/^#\/scan\//) });
});

test('Notify me on a scan that is already running', async ({ page }) => {
  await page.addInitScript(fakePush);
  await mockApis(page);
  const cloud = await mockCloud(page, { scanHangs: true });
  await openApp(page, { settings: { apiKey: '' } });
  await page.setInputFiles('#galleryInput', fixture('tag.jpg'));
  await expect(page.locator('#notifyMeBtn')).toBeVisible();
  await page.click('#notifyMeBtn');
  await expect(page.locator('#notifyMeBtn')).toBeHidden();
  await expect.poll(() => [...cloud.db.docs.values()].some((d) => d?.notify === true)).toBe(true);
});

test('a backend that cannot be reached says so, instead of spinning forever', async ({ page }) => {
  await page.clock.install();
  await mockApis(page);
  await mockCloud(page, { scanHangs: true, failResult: true });
  await openApp(page, { settings: { apiKey: '' } });
  await page.setInputFiles('#galleryInput', fixture('tag.jpg'));
  await expect(page.locator('#serverHint')).toContainText('Sending');
  for (let i = 0; i < 70; i += 1) await page.clock.runFor(1500);
  await expect(page.locator('#resError')).toContainText("Kaimono couldn't reach its server");
  await expect(page.locator('#serverHint')).toBeHidden();
});
