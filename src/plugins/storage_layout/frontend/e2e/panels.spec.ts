import { expect, test } from '@playwright/test';

import { dragFirstEntity, open, recordedCalls } from './helpers';

/**
 * Browser integration tests for the plugin's public UI extension surfaces:
 * the navigation-backed cabinet route, the stock location panel (drawers and
 * bins, not only cabinet roots), the stock item locate action, and the
 * documented large-layout performance budget.
 */

test('location panel resolves a drawer binding and locates with polling', async ({
  page
}) => {
  await open(page, {
    path: '/stock/location/41',
    feature: 'RenderStorageLocationPanel',
    model: 'stocklocation',
    id: 41
  });

  await expect(page.getByTestId('location-panel')).toBeVisible();
  await expect(page.getByTestId('binding-role')).toHaveText('drawer');
  await expect(page.getByText(/Bound to cabinet/)).toBeVisible();
  await expect(page.getByText(/Inherited LED range: L1–50/)).toBeVisible();

  // Actor-safe locate through the session API.
  await page.getByRole('button', { name: 'Locate location' }).click();

  await expect(page.getByTestId('locate-session')).toBeVisible();
  // The create response is pending; the control polls until it settles.
  await expect(page.getByTestId('locate-pending')).toBeVisible();
  await expect(page.getByTestId('locate-session')).toContainText('active', {
    timeout: 10000
  });
  await expect(page.getByTestId('locate-runs')).toBeVisible();

  const posts = (await recordedCalls(page)).filter((call) =>
    call.url.endsWith('/locate-sessions/')
  );
  expect(posts).toHaveLength(1);
  expect(posts[0].body.target).toEqual({ kind: 'location', id: '41' });
  expect(posts[0].body.cabinet).toBe('cab-1');
  expect(posts[0].body.mode).toBe('simulate');

  // At least one poll of the durable status endpoint occurred.
  const gets = (await recordedCalls(page)).filter(
    (call) => call.method === 'GET' && call.url.includes('/locate-sessions/')
  );
  expect(gets.length).toBeGreaterThanOrEqual(1);
});

test('location panel resolves a bin binding', async ({ page }) => {
  await open(page, {
    path: '/stock/location/43',
    feature: 'RenderStorageLocationPanel',
    model: 'stocklocation',
    id: 43
  });

  await expect(page.getByTestId('location-panel')).toBeVisible();
  await expect(page.getByTestId('binding-role')).toHaveText('bin');
  await expect(page.getByText(/Bin A1-01/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Locate location' })).toBeEnabled();
});

test('location panel reports a cabinet root as ambiguous and not locatable', async ({
  page
}) => {
  await open(page, {
    path: '/stock/location/40',
    feature: 'RenderStorageLocationPanel',
    model: 'stocklocation',
    id: 40
  });

  await expect(page.getByTestId('location-panel')).toBeVisible();
  await expect(page.getByTestId('binding-role')).toHaveText('cabinet');
  await expect(page.getByText(/cabinet root is ambiguous/i)).toBeVisible();
  // A cabinet root has no locatable target, so no locate button is offered.
  await expect(page.getByRole('button', { name: 'Locate location' })).toHaveCount(
    0
  );
});

test('location panel reports an unbound location', async ({ page }) => {
  await open(page, {
    path: '/stock/location/999',
    feature: 'RenderStorageLocationPanel',
    model: 'stocklocation',
    id: 999
  });

  await expect(page.getByTestId('location-panel')).toBeVisible();
  await expect(page.getByTestId('binding-role')).toHaveText('unbound');
  await expect(page.getByText(/not bound to a storage layout/)).toBeVisible();
});

test('stock item panel offers an actor-safe item locate action', async ({
  page
}) => {
  await open(page, {
    path: '/stock/item/7',
    feature: 'RenderStockItemPanel',
    model: 'stockitem',
    id: 7,
    instance: {
      pk: 7,
      location: 41,
      in_stock: true,
      // The host supplies the raw stock item API object, whose part is nested
      // as `part_detail` (there is no `part_name` field).
      part_detail: { name: 'Widget', full_name: 'Widget' },
      location_detail: { name: 'Drawer A1' }
    }
  });

  await expect(page.getByTestId('stock-item-panel')).toBeVisible();
  await expect(page.getByText('Widget')).toBeVisible();
  await expect(page.getByText('In stock')).toBeVisible();

  await page.getByRole('button', { name: 'Locate item' }).click();

  await expect(page.getByTestId('locate-session')).toContainText('active', {
    timeout: 10000
  });

  const posts = (await recordedCalls(page)).filter((call) =>
    call.url.endsWith('/locate-sessions/')
  );
  expect(posts).toHaveLength(1);
  expect(posts[0].body.target).toEqual({ kind: 'item', id: '7' });
  expect(posts[0].body.cabinet).toBe('cab-1');
});

test('stock item panel refuses to locate an item which is not in stock', async ({
  page
}) => {
  await open(page, {
    path: '/stock/item/8',
    feature: 'RenderStockItemPanel',
    model: 'stockitem',
    id: 8,
    instance: {
      pk: 8,
      location: 41,
      in_stock: false,
      part_detail: { name: 'Gadget', full_name: 'Gadget' }
    }
  });

  await expect(page.getByTestId('stock-item-panel')).toBeVisible();
  await expect(page.getByText(/not in stock, so it cannot be located/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Locate item' })).toHaveCount(0);
});

test('observing a controller creates a pending job and polls to completion', async ({
  page
}) => {
  await open(page, {
    path: '/cabinets/cab-1/design',
    feature: 'RenderCabinetDesigner'
  });
  await expect(page.getByTestId('cabinet-designer')).toBeVisible();

  await page.getByRole('tab', { name: 'Diagnostics' }).click();
  await page.getByRole('combobox', { name: 'Controller' }).click();
  await page.getByRole('option', { name: 'Controller A' }).click();
  await page.getByRole('button', { name: 'Observe (simulate)' }).click();

  await expect(page.getByTestId('read-job')).toBeVisible();
  // Pending first, then polled to complete.
  await expect(page.getByTestId('read-job')).toContainText('complete', {
    timeout: 10000
  });

  const jobGets = (await recordedCalls(page)).filter(
    (call) => call.method === 'GET' && call.url.includes('/jobs/')
  );
  expect(jobGets.length).toBeGreaterThanOrEqual(1);
});

test('cabinet designer meets the 500 drawer performance budget', async ({
  page
}) => {
  const started = Date.now();

  await open(page, {
    path: '/cabinets/cab-1/design',
    feature: 'RenderCabinetDesigner',
    seed: 'large'
  });
  await expect(page.getByTestId('cabinet-designer')).toBeVisible();

  const entityCount = await page.locator('rect[style*="move"]').count();
  const listCount = await page.getByTestId('drawer-list').getByRole('button').count();
  const elapsed = Date.now() - started;

  expect(entityCount).toBe(500);
  expect(listCount).toBe(500);

  // Interaction remains responsive: a drag commits and updates the geometry.
  const firstDrawer = page.locator('rect[style*="move"]').first();
  await expect(firstDrawer).toHaveAttribute('x', '0');
  await dragFirstEntity(page, 10, 0);
  await expect(firstDrawer).toHaveAttribute('x', '10');

  // Measured, generous budget recorded in the test log.
  console.log(`[perf] 500 drawers rendered in ${elapsed} ms`);
  expect(elapsed).toBeLessThan(10000);
});

test('drawer designer meets the 2,000 bin performance budget', async ({
  page
}) => {
  const started = Date.now();

  await open(page, {
    path: '/drawers/drawer-1/design',
    feature: 'RenderDrawerDesigner',
    seed: 'large'
  });
  await expect(page.getByTestId('drawer-designer')).toBeVisible();

  const entityCount = await page.locator('rect[style*="move"]').count();
  const elapsed = Date.now() - started;

  expect(entityCount).toBe(2000);

  console.log(`[perf] 2000 bins rendered in ${elapsed} ms`);
  expect(elapsed).toBeLessThan(15000);
});
