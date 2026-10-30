// The /install link: Safari's own install steps for this phone, an arrow at the real button, and the
// address cleaned so the Home Screen icon opens the app.
const { test, expect } = require('@playwright/test');
const { mockApis } = require('./helpers');

const UA = {
  safari18: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  safari26: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  chromeIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.0.0 Mobile/15E148 Safari/604.1',
  instagram: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0.0',
  desktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
};

for (const [name, steps, arrow] of [
  ['safari18', ['Tap Share at the bottom of the screen', 'Scroll down and tap Add to Home Screen', 'Tap Add at the top right', 'Open Kaimono from your Home Screen'], 'bottom-centre'],
  ['safari26', ['Tap ⋯ at the bottom right', 'Tap Share', 'Tap Add to Home Screen', 'Keep "Open as Web App" on, then tap Add', 'Open Kaimono from your Home Screen'], 'bottom-right'],
]) {
  test.describe(`iPhone, ${name}`, () => {
    test.use({ userAgent: UA[name], hasTouch: true });
    test('the install link shows Safari\'s steps and points at the button', async ({ page }) => {
      await mockApis(page);
      await page.goto('/install/');
      await expect(page.locator('#installGuide')).toBeVisible();
      await expect(page).toHaveURL(/\/shopping\/?$|:8124\/$/);
      expect(new URL(page.url()).search).toBe('');
      await expect(page.locator('#installSteps > li > p:first-child')).toHaveText(steps);
      await expect(page.locator('#installSteps .hot')).toHaveCount(steps.length - 1);
      await expect(page.locator('#installArrow')).toHaveClass(new RegExp(arrow));
      await expect(page.locator('#introSheet')).toBeHidden(); // the intro waits for the installed app
      await page.click('#installGuideClose');
      await expect(page.locator('#installGuide')).toBeHidden();
    });
  });
}

for (const name of ['chromeIos', 'instagram']) {
  test.describe(`iPhone, ${name}`, () => {
    test.use({ userAgent: UA[name] });
    test('asks for Safari first, with the link to copy', async ({ page, context }) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await mockApis(page);
      await page.goto('/install/');
      await expect(page.locator('#installSteps > li > p:first-child').first()).toHaveText('Open this page in Safari');
      await expect(page.locator('#installLink')).toHaveValue('https://spidyloke.github.io/shopping/install');
      await page.click('[data-copy-install]');
      await expect(page.locator('[data-copy-install]')).toHaveText('Copied');
      await expect(page.locator('#installArrow')).toBeHidden();
    });
  });
}

test.describe('a computer', () => {
  test.use({ userAgent: UA.desktop });
  test('says to open it on a phone', async ({ page }) => {
    await mockApis(page);
    await page.goto('/install/');
    await expect(page.locator('#installSteps > li > p:first-child')).toHaveText(['Open this link on your phone']);
  });
});

test.describe('installed iPhone tip', () => {
  test.use({ userAgent: UA.safari18 });
  test('Home\'s install tip opens the same guide', async ({ page }) => {
    await mockApis(page);
    await page.goto('/');
    await page.evaluate(() => { localStorage.setItem('kc.onboarded', 'true'); localStorage.setItem('kc.apiKey', '"K"'); });
    await page.reload();
    await page.click('#installHow');
    await expect(page.locator('#installGuide')).toBeVisible();
  });
});
