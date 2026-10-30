// End-to-end tests: the real app in Chromium at phone size, with Google, CeX and the exchange
// rate mocked (tests/e2e/helpers.js) so no keys or network are needed.
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: 'http://localhost:8124',
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    permissions: ['camera', 'geolocation'],
    geolocation: { latitude: 35.7295, longitude: 139.7109 },
    launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node tests/serve.mjs',
    port: 8124,
    reuseExistingServer: !process.env.CI,
  },
});
