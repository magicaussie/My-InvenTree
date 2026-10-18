import * as path from 'node:path';

import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for the Storage Layout end-to-end browser checks.
 *
 * Unlike the plugin's own `frontend/playwright.config.ts` (which drives the
 * built bundle against an in-memory fixture), this suite drives the **real**
 * InvenTree host application and the **real** plugin REST API in the isolated
 * Docker stack. Nothing is mocked or intercepted.
 *
 * Module resolution: this config/spec deliberately lives outside the plugin
 * frontend, so it reuses the plugin frontend's installed Playwright. Run it
 * with that `node_modules` on `NODE_PATH`, from the frontend directory, e.g.
 *
 *   cd src/plugins/storage_layout/frontend
 *   NODE_PATH="$PWD/node_modules" \
 *     npx playwright test \
 *     --config ../../../contrib/storage-layout-integration/playwright.config.ts
 *
 * Authentication: the login form is driven once per run in an untraced browser
 * context (see `browser.spec.ts` `beforeAll`) and the session is persisted to
 * `SL_RESULTS_DIR`, so the password never appears in a trace or screenshot.
 *
 * Environment:
 *   SL_BASE_URL         stack base URL           (default http://127.0.0.1:18761)
 *   SL_ADMIN_USER       admin username           (default sl_admin, per seed.py)
 *   SL_ADMIN_PASSWORD   admin password           (required; runtime-generated)
 *   SL_RESULTS_DIR      results directory        (default <this dir>/.runtime)
 *   SL_ASYNC_TIMEOUT    worker poll seconds      (default 45, per api_checks.py)
 */

const BASE_URL = (process.env.SL_BASE_URL || 'http://127.0.0.1:18761').replace(
  /\/+$/,
  ''
);

export const RESULTS_DIR =
  process.env.SL_RESULTS_DIR || path.join(__dirname, '.runtime');

/** Authenticated session cache, written by the untraced login in `beforeAll`. */
export const AUTH_STATE = path.join(RESULTS_DIR, 'browser-auth-state.json');

export default defineConfig({
  testDir: '.',
  testMatch: /browser\.spec\.ts/,
  timeout: 120000,
  expect: { timeout: 20000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  reporter: [['list']],
  outputDir: path.join(RESULTS_DIR, 'playwright-artifacts'),
  use: {
    baseURL: BASE_URL,
    // Populated before the first test runs; see browser.spec.ts.
    storageState: AUTH_STATE,
    // Screenshots and traces are captured for failures only. The password is
    // never sent through a traced context (login happens in beforeAll).
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 30000,
    navigationTimeout: 60000
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }]
});
