import * as fs from 'node:fs';
import * as path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

/**
 * Real end-to-end browser checks for the **Storage Layout & WLED** plugin.
 *
 * These tests drive the actual InvenTree host application and the actual plugin
 * REST API in the isolated Docker stack. There is **no** `page.route`
 * interception and **no** mocked API: every request reaches the live backend,
 * the live background worker and the real native stock model. Fixtures are the
 * ones created by `seed.py` and `api_checks.py` (or the peer
 * `SL_RESULTS_DIR/api-fixtures.json` contract).
 *
 * Route identity (verified against source, not guessed):
 *   - The plugin declares `NAME = 'StorageLayout'` and `SLUG = 'storage-layout'`
 *     (`src/plugins/storage_layout/storage_layout/plugin.py`).
 *   - The host UI serialiser sets `plugin_name = _plugin.slug`
 *     (`src/backend/InvenTree/plugin/base/ui/api.py`), and the host router builds
 *     `/web/plugin/<plugin_name>/<path>` (`src/frontend/src/components/plugins/PluginRoutes.tsx`).
 *   - Therefore the plugin SPA routes live under `/web/plugin/storage-layout/...`
 *     (slug), **not** `/web/plugin/StorageLayout/...` (name).
 *
 * Credentials are supplied by the environment and the interactive login happens
 * once in an untraced browser context (`beforeAll`); no credentials are logged.
 */

const BASE_URL = (process.env.SL_BASE_URL || 'http://127.0.0.1:18761').replace(
  /\/+$/,
  ''
);
const RESULTS_DIR =
  process.env.SL_RESULTS_DIR || path.join(__dirname, '.runtime');

/** Authenticated session cache, written by the untraced login below. */
const AUTH_STATE = path.join(RESULTS_DIR, 'browser-auth-state.json');

//: Plugin REST API base, mounted by `UrlsMixin` at the server root.
const PLUGIN_API = '/plugin/storage-layout/api/v1/';
//: Plugin SPA route prefix, resolved from the plugin slug (see header).
const PLUGIN_WEB = '/web/plugin/storage-layout';

//: Seconds to wait for the background worker (see `api_checks.py` default).
const ASYNC_TIMEOUT = Number(process.env.SL_ASYNC_TIMEOUT || 45) * 1000;

interface DrawerFixture {
  id: string;
  label: string;
  display_number: number;
  x: number;
  y: number;
  width: number;
  height: number;
  location: number | null;
}

interface BinFixture {
  id: string;
  drawer: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  location: number | null;
}

interface ControllerFixture {
  id: string;
  name: string;
}

interface Resolved {
  cabinetId: string;
  cabinetName: string;
  cabinetSlug: string;
  cabinetRevision: number;
  cabinetWidth: number;
  cabinetHeight: number;
  cabinetLocationId: number | null;
  drawers: DrawerFixture[];
  bins: BinFixture[];
  controllers: ControllerFixture[];
  stockItem: { pk: number; location: number } | null;
}

// region fixture discovery

/** Read the peer fixture file, preferring the documented candidates. */
function readFixtureDocument(): any {
  const candidates: string[] = [];

  if (process.env.SL_FIXTURES) {
    candidates.push(process.env.SL_FIXTURES);
  }
  candidates.push(path.join(RESULTS_DIR, 'api-fixtures.json'));
  candidates.push(path.join(RESULTS_DIR, 'latest.json'));

  try {
    const runs = fs
      .readdirSync(RESULTS_DIR)
      .filter((name) => /^api_checks_.*\.json$/.test(name))
      .sort();
    if (runs.length > 0) {
      candidates.push(path.join(RESULTS_DIR, runs[runs.length - 1]));
    }
  } catch {
    /* results directory not present yet */
  }

  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      }
    } catch {
      /* try the next candidate */
    }
  }

  return null;
}

/** Extract the cabinet id from the (loosely specified) fixture document. */
function pickCabinetId(document: any): string | null {
  if (!document) {
    return null;
  }

  const candidates = [
    document.cabinet,
    document.cabinet_id,
    document.cabinetId,
    document.fixtures?.cabinet,
    document.fixtures?.cabinet_id,
    document.ids?.cabinet,
    document.cabinets?.[0]?.id
  ];

  for (const value of candidates) {
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
    if (value && typeof value.id === 'string') {
      return value.id;
    }
  }

  return null;
}

/** Extract optional native location ids from the fixture document. */
function pickNativeLocations(document: any): any {
  if (!document) {
    return null;
  }
  return (
    document.locations ??
    document.fixtures?.locations ??
    document.native_locations ??
    document.fixtures?.native_locations ??
    null
  );
}

/** GET a URL against the live backend and parse the JSON body. */
async function getJson(page: Page, url: string): Promise<any> {
  const response = await page.request.get(url.startsWith('http') ? url : `${BASE_URL}${url}`, {
    headers: { Accept: 'application/json' }
  });

  if (!response.ok()) {
    throw new Error(`GET ${url} failed with HTTP ${response.status()}`);
  }

  return response.json();
}

/**
 * POST JSON to the live backend using the browser session.
 *
 * `page.request` does not add the Django CSRF header automatically, so the
 * `csrftoken` cookie is copied into `X-CSRFToken` explicitly.
 */
async function postJson(page: Page, url: string, body: unknown = {}): Promise<any> {
  const csrf = (await page.context().cookies()).find(
    (cookie) => cookie.name === 'csrftoken'
  )?.value;

  const response = await page.request.post(
    url.startsWith('http') ? url : `${BASE_URL}${url}`,
    { data: body, headers: csrf ? { 'X-CSRFToken': csrf } : {} }
  );

  if (!response.ok()) {
    throw new Error(`POST ${url} failed with HTTP ${response.status()}`);
  }

  return response.json().catch(() => null);
}

//: Cache the cabinet selection so repeated calls stay on the same aggregate;
//: geometry is always re-read from the live API (see `resolveContext`).
let cachedCabinetId: string | null = null;

/**
 * Resolve the fixtures for a test run.
 *
 * The peer fixture file supplies the cabinet id; every other identifier
 * (drawers, bins, native locations, controllers, a stock item) is read from the
 * **live** plugin API so the checks stay honest about the deployed state.
 */
async function resolveContext(page: Page): Promise<Resolved> {
  const document = readFixtureDocument();
  const nativeLocations = pickNativeLocations(document);

  let cabinetId = cachedCabinetId ?? pickCabinetId(document);

  if (!cabinetId) {
    const list = await getJson(page, `${PLUGIN_API}cabinets/`);
    cabinetId = list?.results?.[0]?.id ?? null;
  }

  if (!cabinetId) {
    throw new Error(
      `No storage-layout cabinet found. Run seed.py and api_checks.py first, ` +
        `or set SL_RESULTS_DIR to the directory containing api-fixtures.json.`
    );
  }

  cachedCabinetId = cabinetId;

  const layout = await getJson(page, `${PLUGIN_API}cabinets/${cabinetId}/layout/`);
  const drawers: DrawerFixture[] = layout.drawers ?? [];
  const bins: BinFixture[] = layout.bins ?? [];

  let controllers: ControllerFixture[] = [];
  try {
    const electrical = await getJson(
      page,
      `${PLUGIN_API}cabinets/${cabinetId}/electrical/`
    );
    controllers = (electrical.controllers ?? []).map((controller: any) => ({
      id: controller.id,
      name: controller.name
    }));
  } catch {
    /* the diagnostics checks self-skip when no controller is available */
  }

  const cabinetLocationId =
    layout.cabinet?.location ?? nativeLocations?.cabinet ?? null;

  // A stock item at a bound location is optional. Prefer the peer fixture
  // contract (`fixtures.stock_item`), then fall back to a live lookup; the
  // item-panel check skips cleanly when nothing exists.
  let stockItem: { pk: number; location: number } | null = null;
  const contractItem = document?.stock_item ?? document?.fixtures?.stock_item;

  if (contractItem && typeof contractItem.pk === 'number') {
    stockItem = {
      pk: contractItem.pk,
      location: Number(contractItem.location ?? 0)
    };
  }

  const candidateLocations = [
    ...drawers.map((drawer) => drawer.location),
    ...bins.map((bin) => bin.location)
  ].filter((value): value is number => typeof value === 'number');

  for (const location of candidateLocations) {
    if (stockItem) {
      break;
    }
    try {
      const stock = await getJson(
        page,
        `/api/stock/?location=${location}&in_stock=true&limit=1`
      );
      const item = stock?.results?.[0];
      if (item?.pk) {
        stockItem = { pk: item.pk, location: item.location };
        break;
      }
    } catch {
      /* try the next location */
    }
  }

  // Bins may also be supplied directly by the peer contract when the live
  // layout has not been populated yet.
  const fallbackBins: BinFixture[] =
    bins.length > 0
      ? bins
      : (nativeLocations?.bins ?? []).map((bin: any) => ({
          id: String(bin.id ?? bin.pk ?? ''),
          drawer: String(bin.drawer ?? ''),
          label: String(bin.label ?? ''),
          x: 0,
          y: 0,
          width: 0,
          height: 0,
          location: bin.location ?? null
        }));

  return {
    cabinetId,
    cabinetName: layout.cabinet?.name ?? '',
    cabinetSlug: layout.cabinet?.slug ?? '',
    cabinetRevision: layout.cabinet?.revision ?? 0,
    cabinetWidth: layout.cabinet?.width_units ?? 0,
    cabinetHeight: layout.cabinet?.height_units ?? 0,
    cabinetLocationId,
    drawers,
    bins: fallbackBins,
    controllers,
    stockItem
  };
}

// endregion

// region interaction helpers

/**
 * Stop any locate session / reservation held by a cabinet.
 *
 * The plugin allows only one active operation per cabinet, so a previous run's
 * session (or an api_checks session) must be cleared before locating, and after
 * the assertion, to keep repeated runs isolated. This uses the real
 * `cabinets/<id>/stop/` endpoint the UI's "Stop it and retry" path targets.
 */
async function clearCabinetOperation(page: Page, cabinetId: string) {
  await postJson(page, `${PLUGIN_API}cabinets/${cabinetId}/stop/`);
}

/**
 * Save a success screenshot to `SL_RESULTS_DIR` for evidence.
 *
 * The captured pages are authenticated but never show credentials (login is
 * performed once in the untraced context above).
 */
async function captureEvidence(page: Page, name: string) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  await page.screenshot({ path: path.join(RESULTS_DIR, name), fullPage: true });
}

/** Drag an editor entity by a canvas delta (canvas units == pixels at zoom 1). */
async function dragEntity(page: Page, index: number, dx: number, dy: number) {
  const rect = page.locator('rect[style*="move"]').nth(index);
  await rect.scrollIntoViewIfNeeded();
  const box = await rect.boundingBox();
  if (!box) {
    throw new Error('editor entity has no bounding box');
  }

  const startX = box.x + Math.min(8, Math.max(2, box.width / 4));
  const startY = box.y + Math.min(8, Math.max(2, box.height / 4));

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + dx, startY + dy, { steps: 10 });
  await page.mouse.up();
}

/**
 * Open a plugin-provided panel tab on a native detail page.
 *
 * The location panel is titled `Storage Layout`; the stock item panel is titled
 * `Locate` (`storage_layout/plugin.py:get_ui_panels`).
 */
async function openPluginPanel(
  page: Page,
  pageKey: string,
  title = 'Storage Layout'
) {
  await page
    .getByLabel(`panel-tabs-${pageKey}`)
    .getByRole('tab', { name: title })
    .first()
    .click();
}

// endregion

// region authentication

/**
 * Log in once against the real host login form and cache the session.
 *
 * The login runs in a dedicated browser context created here, which Playwright
 * does **not** trace, so the password used by
 * `AuthenticationForm` never reaches a trace or a failure screenshot.
 */
test.beforeAll(async ({ browser }) => {
  const username = process.env.SL_ADMIN_USER || 'sl_admin';
  const password = process.env.SL_ADMIN_PASSWORD || '';

  if (!password) {
    throw new Error(
      'SL_ADMIN_PASSWORD is required to run the Storage Layout browser checks.'
    );
  }

  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  // A fresh, untraced context: `browser.newContext()` would otherwise inherit
  // the project `storageState` (which does not exist yet) and the password
  // would be sent through a traced context.
  const context = await browser.newContext({ storageState: undefined });
  const loginPage = await context.newPage();

  // The SPA must be hydrated before the form reacts to input; on a cold stack a
  // `domcontentloaded` interaction can land before React attaches its handlers.
  await loginPage.goto(`${BASE_URL}/web/login`, { waitUntil: 'load' });
  await loginPage.waitForLoadState('networkidle');

  const submitLogin = async () => {
    await loginPage.getByLabel('login-username').fill(username);
    await loginPage.getByLabel('login-password').fill(password);
    await loginPage.getByRole('button', { name: 'Log In' }).click();
    // The host redirects through /web/logged-in to /web/home.
    await loginPage.waitForURL(/\/web\/(logged-in|home)/, { timeout: 30000 });
  };

  try {
    await submitLogin();
  } catch {
    // Cold-start hydration race: reload and retry once against the settled app.
    await loginPage.goto(`${BASE_URL}/web/login`, { waitUntil: 'networkidle' });
    await submitLogin();
  }

  // Wait for the authenticated chrome rather than a specific transient URL.
  await loginPage.getByLabel('navigation-menu').waitFor({ timeout: 30000 });

  await context.storageState({ path: AUTH_STATE });
  await context.close();
});

// endregion

test.describe('Storage Layout real-stack browser integration', () => {
  test('the host mounts the plugin route under its slug and lists real cabinets', async ({
    page
  }) => {
    // Route identity: the host derives the SPA path from the plugin *slug*.
    const routes = await getJson(page, '/api/plugins/ui/features/route/');
    const listRoute = (routes ?? []).find(
      (route: any) => route.key === 'storage-layout-cabinets'
    );
    expect(listRoute, 'storage-layout route feature is registered').toBeTruthy();
    expect(listRoute.plugin_name).toBe('storage-layout');
    expect(listRoute.options?.path).toBe('cabinets');

    const navigation = await getJson(page, '/api/plugins/ui/features/navigation/');
    const navItem = (navigation ?? []).find(
      (item: any) => item.key === 'storage-layout-nav'
    );
    expect(navItem, 'storage-layout navigation item is registered').toBeTruthy();
    expect(navItem.options?.url).toBe('plugin/storage-layout/cabinets');

    const context = await resolveContext(page);

    // The plugin navigation tab is present in the real host chrome ...
    await page.goto('/web/home');
    const navTab = page.getByRole('tab', { name: 'Storage Layout' }).first();
    await expect(navTab).toBeVisible();
    await navTab.click();

    // ... and it lands on the slug-based plugin route.
    await expect(page).toHaveURL(new RegExp(`${PLUGIN_WEB}/cabinets`));
    const list = page.getByTestId('cabinet-list');
    await expect(list).toBeVisible();

    // The list is backed by the real API: it renders table rows for the
    // cabinets created by `api_checks.py` (header row + at least one data row).
    await expect(list.getByRole('row').first()).toBeVisible();
    expect(await list.getByRole('row').count()).toBeGreaterThan(1);
    if (context.cabinetName) {
      await expect(list.getByText(context.cabinetName).first()).toBeVisible();
    }
  });

  test('cabinet designer resizes then drags a drawer and persists it across a reload', async ({
    page
  }) => {
    const resolved = await resolveContext(page);
    expect(resolved.drawers.length).toBeGreaterThan(0);

    const order = resolved.drawers.map((drawer) => drawer.id);
    const target = resolved.drawers[0];
    const index = order.indexOf(target.id);
    const targetWidth = 300;

    await page.goto(`${PLUGIN_WEB}/cabinets/${resolved.cabinetId}/design`);
    await expect(page.getByTestId('cabinet-designer')).toBeVisible();
    await expect(page.locator('rect[style*="move"]')).toHaveCount(order.length);

    // The api_checks fixture uses full-width drawers, so the operator first
    // narrows the drawer (through the numeric inspector) to make horizontal
    // room, then drags it. This keeps the edit inside the cabinet and clear of
    // the drawers below, and stays valid across repeated runs.
    await page.getByTestId('drawer-list').getByRole('button').first().click();
    const inspector = page.getByTestId('drawer-inspector');
    await expect(inspector).toBeVisible();

    const before = await getJson(
      page,
      `${PLUGIN_API}cabinets/${resolved.cabinetId}/layout/`
    );
    const beforeRevision = before.cabinet.revision;
    const beforeX = before.drawers.find((drawer: any) => drawer.id === target.id).x;
    const idealDx =
      beforeX + 60 + targetWidth <= before.cabinet.width_units ? 60 : -60;

    const widthInput = inspector.getByLabel('Width', { exact: true });
    await widthInput.fill(String(targetWidth));
    await widthInput.blur();

    await dragEntity(page, index, idealDx, 0);

    // A committed command marks the draft dirty; a clamped/no-op drag would
    // leave the toolbar on "Saved".
    await expect(page.getByText('Unsaved changes')).toBeVisible();

    await page.getByLabel('Save layout').click();

    // Save is compare-and-swap: the server advances the revision by exactly one.
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();
    await expect(page.getByText(`revision ${beforeRevision + 1}`)).toBeVisible();

    // Reload from scratch and prove the geometry survived in the database.
    await page.reload();
    await expect(page.getByTestId('cabinet-designer')).toBeVisible();
    await captureEvidence(page, 'evidence-cabinet-designer.png');

    const after = await getJson(
      page,
      `${PLUGIN_API}cabinets/${resolved.cabinetId}/layout/`
    );
    const afterDrawer = after.drawers.find(
      (drawer: any) => drawer.id === target.id
    );
    expect(afterDrawer.width).toBe(targetWidth);
    expect(afterDrawer.x).toBe(beforeX + idealDx);
  });

  test('cabinet designer numeric drawer edit persists across a reload', async ({
    page
  }) => {
    const resolved = await resolveContext(page);
    const target = resolved.drawers[0];
    expect(target, 'at least one drawer exists').toBeTruthy();

    await page.goto(`${PLUGIN_WEB}/cabinets/${resolved.cabinetId}/design`);
    await expect(page.getByTestId('cabinet-designer')).toBeVisible();

    await page.getByLabel(`Drawer ${target.label}`).click();
    const inspector = page.getByTestId('drawer-inspector');
    await expect(inspector).toBeVisible();

    const before = await getJson(
      page,
      `${PLUGIN_API}cabinets/${resolved.cabinetId}/layout/`
    );
    const beforeDrawer = before.drawers.find(
      (drawer: any) => drawer.id === target.id
    );
    const current = beforeDrawer.height;
    // Toggle between two in-bounds, non-overlapping heights so the check is
    // idempotent across repeated runs against the persistent stack.
    const next = current === 150 ? 200 : 150;

    const heightInput = inspector.getByLabel('Height', { exact: true });
    await heightInput.fill(String(next));
    await heightInput.blur();

    await expect(page.getByText('Unsaved changes')).toBeVisible();
    await page.getByLabel('Save layout').click();
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();

    await page.reload();
    await expect(page.getByTestId('cabinet-designer')).toBeVisible();

    const after = await getJson(
      page,
      `${PLUGIN_API}cabinets/${resolved.cabinetId}/layout/`
    );
    const afterDrawer = after.drawers.find(
      (drawer: any) => drawer.id === target.id
    );
    expect(afterDrawer.height).toBe(next);
  });

  test('drawer (bin) designer numeric bin edit persists across a reload', async ({
    page
  }) => {
    const resolved = await resolveContext(page);
    const drawer = resolved.drawers.find((candidate) =>
      resolved.bins.some((bin) => bin.drawer === candidate.id)
    );
    test.skip(!drawer, 'no drawer with bins was found; run api_checks.py first');

    await page.goto(`${PLUGIN_WEB}/drawers/${drawer?.id}/design`);
    await expect(page.getByTestId('drawer-designer')).toBeVisible();
    await expect(page.getByTestId('bin-list')).toBeVisible();

    // Regression guard: the drawer designer previously compared the drawer's
    // cabinet-space rectangle against the drawer interior, emitting a false
    // "Drawer ... extends outside the cabinet" blocking error and an erroneous
    // "Layout cannot be saved" banner. The projection now carries the real
    // cabinet dimensions and the designer validates against the front plane.
    const expectValidLayout = async () => {
      await expect(page.getByText('Layout is valid')).toBeVisible();
      await expect(
        page.getByText(/extends outside the cabinet/)
      ).toHaveCount(0);
      await expect(page.getByText('Layout cannot be saved')).toHaveCount(0);
    };
    await expectValidLayout();

    const before = await getJson(page, `${PLUGIN_API}drawers/${drawer?.id}/layout/`);
    const beforeBins = before.bins ?? [];
    expect(beforeBins.length).toBeGreaterThan(0);

    await page.getByTestId('bin-list').getByRole('button').first().click();
    const inspector = page.getByTestId('bin-inspector');
    await expect(inspector).toBeVisible();

    const current = beforeBins[0].height;
    const next = current === 100 ? 120 : 100;

    const heightInput = inspector.getByLabel('Height', { exact: true });
    await heightInput.fill(String(next));
    await heightInput.blur();

    await expect(page.getByText('Unsaved changes')).toBeVisible();
    await page.getByLabel('Save layout').click();
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();

    await page.reload();
    await expect(page.getByTestId('drawer-designer')).toBeVisible();
    await captureEvidence(page, 'evidence-drawer-designer.png');

    // Still no false blocking error after save + reload.
    await expectValidLayout();

    const after = await getJson(page, `${PLUGIN_API}drawers/${drawer?.id}/layout/`);
    expect(after.bins[0].height).toBe(next);
  });

  test('native stock location panel resolves the drawer binding and locates with polling', async ({
    page
  }) => {
    const resolved = await resolveContext(page);
    const drawer = resolved.drawers.find(
      (candidate) => typeof candidate.location === 'number'
    );
    test.skip(!drawer, 'no bound native drawer location was found');

    const binding = await getJson(
      page,
      `${PLUGIN_API}locations/${drawer?.location}/binding/`
    );
    expect(binding.role).toBe('drawer');
    expect(
      binding.locatable,
      'the drawer must have an LED allocation (api_checks.py publishes one)'
    ).toBe(true);

    // Clear any session left by a previous run so the cabinet is not reported
    // busy when this test locates (the plugin allows one operation per cabinet).
    await clearCabinetOperation(page, resolved.cabinetId);

    // Record real polling traffic to the durable status endpoint (observation
    // only - this is not an interceptor).
    const polls: string[] = [];
    page.on('request', (request) => {
      if (
        request.method() === 'GET' &&
        request.url().includes('/locate-sessions/')
      ) {
        polls.push(request.url());
      }
    });

    await page.goto(`/web/stock/location/${drawer?.location}`);
    await openPluginPanel(page, 'stocklocation');

    await expect(page.getByTestId('location-panel')).toBeVisible();
    await expect(page.getByTestId('binding-role')).toHaveText('drawer');
    if (resolved.cabinetSlug) {
      await expect(page.getByTestId('binding-cabinet')).toContainText(
        resolved.cabinetSlug
      );
    }

    try {
      // Actor-safe simulated locate: the create response is pending and the
      // control polls the worker-driven session until it becomes active.
      await page.getByRole('button', { name: 'Locate location' }).click();
      await expect(page.getByTestId('locate-session')).toBeVisible();
      await expect(page.getByTestId('locate-session')).toContainText('active', {
        timeout: ASYNC_TIMEOUT
      });

      expect(
        polls.length,
        'the control polled the durable session status'
      ).toBeGreaterThanOrEqual(1);
    } finally {
      // Never leave the cabinet busy for the next run.
      await clearCabinetOperation(page, resolved.cabinetId);
    }
  });

  test('simulated observe dispatches to the worker and is polled to completion', async ({
    page
  }) => {
    const resolved = await resolveContext(page);
    const controller = resolved.controllers[0];
    test.skip(!controller, 'no controller is configured; run api_checks.py first');

    const polls: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'GET' && request.url().includes('/jobs/')) {
        polls.push(request.url());
      }
    });

    const electrical = page.waitForResponse(
      (response) =>
        response.url().includes(`/cabinets/${resolved.cabinetId}/electrical/`),
      { timeout: 60000 }
    );

    await page.goto(`${PLUGIN_WEB}/cabinets/${resolved.cabinetId}/design`);
    await expect(page.getByTestId('cabinet-designer')).toBeVisible();
    // Wait for the topology so the controller select is populated.
    await electrical;

    await page.getByRole('tab', { name: 'Diagnostics' }).click();
    await expect(page.getByTestId('simulation-panel')).toBeVisible();

    await page.getByRole('combobox', { name: 'Controller' }).click();
    await page.getByRole('option', { name: controller?.name ?? '' }).click();
    await page.getByRole('button', { name: 'Observe (simulate)' }).click();

    await expect(page.getByTestId('read-job')).toBeVisible();
    // Pending first, then polled to a terminal state by the background worker.
    await expect(page.getByTestId('read-job')).toContainText('complete', {
      timeout: ASYNC_TIMEOUT
    });

    expect(polls.length, 'the panel polled the durable job status').toBeGreaterThanOrEqual(
      1
    );
  });

  test('native stock item panel locates the item through the plugin session API', async ({
    page
  }) => {
    const resolved = await resolveContext(page);
    test.skip(
      !resolved.stockItem,
      'no in-stock item at a bound location; the item-panel check is not applicable'
    );

    const item = resolved.stockItem as { pk: number; location: number };

    // The cabinet permits one operation at a time; clear any leftover session.
    await clearCabinetOperation(page, resolved.cabinetId);

    try {
      await page.goto(`/web/stock/item/${item.pk}`);
      await openPluginPanel(page, 'stockitem', 'Locate');
      await expect(page.getByTestId('stock-item-panel')).toBeVisible();

      // The panel resolves the item's location binding asynchronously; wait for
      // the actor-safe locate action instead of sampling the DOM too early.
      const locateButton = page.getByRole('button', { name: 'Locate item' });
      await expect(locateButton).toBeVisible({ timeout: 20000 });
      await locateButton.click();

      await expect(page.getByTestId('locate-session')).toContainText('active', {
        timeout: ASYNC_TIMEOUT
      });
    } finally {
      // Never leave the cabinet busy for the next run.
      await clearCabinetOperation(page, resolved.cabinetId);
    }
  });
});
