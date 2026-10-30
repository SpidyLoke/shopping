// Upgrading: an account first (the anonymous one upgraded in place), Stripe's page, then the plan.
const { test, expect } = require('@playwright/test');
const { mockApis, openApp } = require('./helpers');
const { mockCloud } = require('./cloud');

test.use({ serviceWorkers: 'block' }); // the stubs for firebase-config.js must win

async function stripePage(page) {
  const visits = [];
  await page.route('https://checkout.stripe.com/**', (r) => {
    visits.push(r.request().url());
    r.fulfill({ contentType: 'text/html', body: '<h1>Stripe Checkout</h1>' });
  });
  await page.route('https://billing.stripe.com/**', (r) => {
    visits.push(r.request().url());
    r.fulfill({ contentType: 'text/html', body: '<h1>Stripe portal</h1>' });
  });
  return visits;
}

test('trip pass: plans from Stripe, make an account, pay, and the pass shows up', async ({ page }) => {
  await mockApis(page);
  const cloud = await mockCloud(page);
  const stripe = await stripePage(page);
  await openApp(page, { settings: { apiKey: '' } });
  await page.click('#settingsBtn');
  await expect(page.locator('#planLine')).toContainText('Free plan');
  await page.click('#upgradeBtn');
  await expect(page.locator('.plan-card')).toHaveCount(2);
  await expect(page.locator('.plan-card[data-plan="pass"]')).toContainText('RM 19.90');
  await expect(page.locator('.plan-card[data-plan="pass"]')).toContainText('60 scans over 14 days');
  await expect(page.locator('.plan-card[data-plan="monthly"]')).toContainText('RM 29.90/month');
  await page.click('.plan-card[data-plan="pass"]');
  // No account yet: make one, which keeps the same account ID
  await expect(page.locator('#accountSheet')).toBeVisible();
  await expect(page.locator('#accountWhy')).toContainText("isn't tied to this phone");
  await page.fill('#accEmail', 'flip@example.my');
  await page.fill('#accPassword', 'hunter2hunter2');
  await page.click('#accountSubmit');
  await expect.poll(() => stripe.length).toBe(1);
  expect(cloud.calls.checkout).toEqual([{ uid: 'anon-1', plan: 'pass' }]);
  // Stripe confirms the payment to the backend, then sends the shopper back
  await cloud.pay('anon-1', 'pass');
  await page.goto('/#/upgraded');
  await expect(page.locator('#undoText')).toContainText('Trip pass on: 60 scans until');
  await expect(page.locator('#undoBtn')).toBeHidden();
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.locator('#quotaLine')).toHaveText(/^60 of 60 scans left · pass until /);
  await page.click('#settingsBtn');
  await expect(page.locator('#accountLine')).toContainText('flip@example.my');
  await expect(page.locator('#planLine')).toContainText('Trip pass');
  await expect(page.locator('#upgradeBtn')).toHaveText('Extend');
});

test('an email already in use switches to sign in; signing in brings that account\'s plan', async ({ page }) => {
  await mockApis(page);
  const cloud = await mockCloud(page);
  await openApp(page, { settings: { apiKey: '' } });
  // An account made earlier (another phone), with the monthly plan
  await page.evaluate(() => localStorage.setItem('__kcAccounts', JSON.stringify({ 'flip@example.my': { password: 'hunter2hunter2', uid: 'acct-9' } })));
  await cloud.pay('acct-9', 'monthly');
  await page.click('#settingsBtn');
  await page.click('#accountBtn'); // Sign in
  await expect(page.locator('#accountTitle')).toHaveText('Sign in');
  await page.click('#accountSwitch');
  await page.fill('#accEmail', 'flip@example.my');
  await page.fill('#accPassword', 'hunter2hunter2');
  await page.click('#accountSubmit');
  await expect(page.locator('#accountMsg')).toHaveText('That email already has an account. Sign in instead.');
  await expect(page.locator('#accountTitle')).toHaveText('Sign in');
  await page.fill('#accPassword', 'wrong-password');
  await page.click('#accountSubmit');
  await expect(page.locator('#accountMsg')).toHaveText('Wrong email or password.');
  await page.fill('#accPassword', 'hunter2hunter2');
  await page.click('#accountSubmit');
  await expect(page.locator('#accountSheet')).toBeHidden();
  await page.click('#settingsBtn');
  await expect(page.locator('#planLine')).toContainText('Monthly plan');
  await expect(page.locator('#manageBtn')).toBeVisible();
  await expect(page.locator('#upgradeBtn')).toBeHidden();
  await expect(page.locator('#accountId')).toHaveText('Account ID acct-9');
});

test('Manage opens Stripe\'s portal; signing out leaves a fresh free install', async ({ page }) => {
  await mockApis(page);
  const cloud = await mockCloud(page);
  const stripe = await stripePage(page);
  await openApp(page, { settings: { apiKey: '' } });
  await page.evaluate(() => {
    localStorage.setItem('__kcAccounts', JSON.stringify({ 'flip@example.my': { password: 'hunter2hunter2', uid: 'acct-9' } }));
    localStorage.setItem('__kcUser', JSON.stringify({ uid: 'acct-9', email: 'flip@example.my', isAnonymous: false }));
  });
  await cloud.pay('acct-9', 'monthly');
  await page.reload();
  await page.click('#settingsBtn');
  await expect(page.locator('#manageBtn')).toBeVisible();
  await page.click('#manageBtn');
  await expect.poll(() => stripe.length).toBe(1);
  expect(stripe[0]).toContain('billing.stripe.com');
  await page.goto('/');
  await page.click('#settingsBtn');
  page.once('dialog', (d) => d.accept());
  await page.click('#accountBtn'); // Sign out
  await expect(page.locator('#accountLine')).toContainText('Not signed in');
  await expect(page.locator('#planLine')).toContainText('Free plan');
});
