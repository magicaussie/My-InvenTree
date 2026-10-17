import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the plugin browser integration tests.
 *
 * The tests are self-contained: Playwright starts the Vite harness (which first
 * builds the plugin bundle) and drives it against an in-memory fixture API. No
 * Django backend, controller or other network service is required.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5199',
    trace: 'off'
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run harness:prepare && npm run harness',
    url: 'http://127.0.0.1:5199/',
    reuseExistingServer: false,
    timeout: 180000,
    stdout: 'pipe',
    stderr: 'pipe'
  }
});
