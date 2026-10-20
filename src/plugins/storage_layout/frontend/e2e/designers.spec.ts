import { type Page, expect, test } from '@playwright/test';

import { dragFirstEntity, open, recordedCalls } from './helpers';

/**
 * Browser integration tests for the Storage Layout plugin frontend.
 *
 * Each test loads the **real built plugin bundle** in Chromium via the harness
 * (which wires the host `window` globals) and drives it against an in-memory
 * fixture API. The fixture opens no sockets: it is the only "backend".
 */

async function dragFirstDrawer(page: Page, dx: number, dy: number) {
  await dragFirstEntity(page, dx, dy);
}

test('the built bundle exposes the documented entry functions', async ({
  page
}) => {
  await open(page, { path: '/cabinets', feature: 'RenderCabinetList' });

  const info = await page.evaluate(() => {
    const file = (window as unknown as { __pluginFile: string }).__pluginFile;
    const mod = (
      window as unknown as { __pluginModule: Record<string, unknown> }
    ).__pluginModule;
    return { file, exports: Object.keys(mod ?? {}).sort() };
  });

  expect(info.file).toMatch(/^storage_layout-.*\.js$/);
  expect(info.exports).toEqual(
    expect.arrayContaining([
      'RenderCabinetList',
      'RenderCabinetDesigner',
      'RenderDrawerDesigner',
      'RenderStorageLocationPanel',
      'RenderStockItemPanel'
    ])
  );
});

test('cabinet designer loads geometry, allocation bands and diagnostics', async ({
  page
}) => {
  await open(page, {
    path: '/cabinets/cab-1/design',
    feature: 'RenderCabinetDesigner'
  });

  await expect(page.getByTestId('cabinet-designer')).toBeVisible();
  await expect(
    page.getByRole('application', { name: 'Cabinet front view' })
  ).toBeVisible();
  await expect(page.getByTestId('drawer-list')).toBeVisible();
  await expect(page.getByTestId('allocation-bands')).toBeVisible();
  await expect(page.getByTestId('coverage-ruler')).toBeVisible();
  // Client validation renders a valid-state summary.
  await expect(page.getByText('Layout is valid')).toBeVisible();
  // Diagnostics supplied by the layout GET are surfaced explicitly.
  await expect(page.getByTestId('server-diagnostics')).toBeVisible();
  await expect(page.getByTestId('server-diagnostics')).toContainText(
    'Server diagnostics'
  );
  await expect(page.getByText('revision 3')).toBeVisible();
});

test('retired structure workflow is absent in the built bundle', async ({ page }) => {
  await open(page, { path: '/cabinets/cab-1/design', feature: 'RenderCabinetDesigner' });
  await expect(page.getByTestId('drawer-list')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Cabinet / Structure' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Load / use saved structure' })).toHaveCount(0);
});

test('pointer drag moves a drawer, undo reverts it, save uses compare-and-swap', async ({
  page
}) => {
  await open(page, {
    path: '/cabinets/cab-1/design',
    feature: 'RenderCabinetDesigner'
  });
  await expect(page.getByTestId('cabinet-designer')).toBeVisible();

  const firstDrawer = page.locator('rect[style*="move"]').first();
  await expect(firstDrawer).toHaveAttribute('x', '10');

  // Drag right by 30px (grid 10 -> snapped to 30 units).
  await dragFirstDrawer(page, 30, 0);
  await expect(firstDrawer).toHaveAttribute('x', '40');
  await expect(page.getByText('Unsaved changes')).toBeVisible();

  // Undo restores the original position.
  await page.getByLabel('Undo').click();
  await expect(firstDrawer).toHaveAttribute('x', '10');

  // Redo and then save.
  await page.getByLabel('Redo').click();
  await expect(firstDrawer).toHaveAttribute('x', '40');

  await page.getByLabel('Save layout').click();
  await expect(page.getByText('revision 4')).toBeVisible();

  const puts = (await recordedCalls(page)).filter((call) => call.method === 'PUT');
  expect(puts).toHaveLength(1);
  expect(puts[0].headers?.['If-Match']).toBe('"3"');
  const drawer1 = puts[0].body.drawers.find(
    (drawer: { id: string }) => drawer.id === 'drawer-1'
  );
  expect(drawer1.x).toBe(40);
});

test('topology save is blocked while a dirty drawer layout is preserved', async ({ page }) => {
  await open(page, {
    path: '/cabinets/cab-1/design',
    feature: 'RenderCabinetDesigner'
  });
  await dragFirstDrawer(page, 30, 0);
  await expect(page.getByText('Unsaved changes')).toBeVisible();

  await page.getByRole('tab', { name: 'Topology', exact: true }).click();
  const topology = page.getByTestId('topology-editor');
  await topology.getByLabel('Name', { exact: true }).fill('Draft controller');
  const saveTopology = topology.getByRole('button', { name: 'Save topology' });
  // A user attempt cannot submit or trigger the layout-discarding refresh.
  await saveTopology.click({ force: true });
  await expect(saveTopology).toBeDisabled();
  await expect(topology.getByText('Save or discard unsaved layout changes before saving topology.')).toBeVisible();
  expect((await recordedCalls(page)).filter((call) => call.method === 'PUT')).toHaveLength(0);

  await page.getByRole('tab', { name: 'Drawers and Bins', exact: true }).click();
  await expect(page.locator('rect[style*="move"]').first()).toHaveAttribute('x', '40');
  await expect(page.getByText('Unsaved changes')).toBeVisible();
  await page.getByLabel('Save layout').click();
  await expect(page.getByText('Unsaved changes')).not.toBeVisible();
  const layoutSave = (await recordedCalls(page)).find((call) => call.method === 'PUT');
  expect(layoutSave?.body.drawers.find((drawer: { id: string }) => drawer.id === 'drawer-1').x).toBe(40);
  await page.getByRole('tab', { name: 'Topology', exact: true }).click();
  await expect(saveTopology).toBeEnabled();

});

test('mapping publication cannot discard unsaved drawer layout edits', async ({ page }) => {
  await open(page, { path: '/cabinets/cab-1/design', feature: 'RenderCabinetDesigner' });
  await dragFirstDrawer(page, 30, 0);
  await expect(page.getByText('Unsaved changes')).toBeVisible();
  await page.getByRole('tab', { name: 'Mapping', exact: true }).click();
  const mapping = page.getByTestId('mapping-panel');
  await expect(mapping.getByRole('button', { name: 'Publish mapping' })).toBeDisabled();
  expect((await recordedCalls(page)).filter((call) => call.url.endsWith('/mapping-publish/'))).toHaveLength(0);
  await page.getByRole('tab', { name: 'Drawers and Bins', exact: true }).click();
  await expect(page.locator('rect[style*="move"]').first()).toHaveAttribute('x', '40');
  await expect(page.getByText('Unsaved changes')).toBeVisible();
  await page.getByLabel('Save layout').click();
  await expect(page.getByText('Unsaved changes')).not.toBeVisible();
  const layoutSave = (await recordedCalls(page)).find((call) => call.method === 'PUT');
  expect(layoutSave?.body.drawers.find((drawer: { id: string }) => drawer.id === 'drawer-1').x).toBe(40);
});

test('numeric inspector edits are undoable', async ({ page }) => {
  await open(page, {
    path: '/cabinets/cab-1/design',
    feature: 'RenderCabinetDesigner'
  });
  await expect(page.getByTestId('cabinet-designer')).toBeVisible();
  await page.getByTestId('drawer-list').getByRole('button').first().click();

  const inspector = page.getByTestId('drawer-inspector');
  const widthInput = inspector.getByLabel('Width', { exact: true });
  await widthInput.fill('300');
  await widthInput.blur();
  await expect(page.locator('rect[style*="move"]').first()).toHaveAttribute(
    'width',
    '300'
  );

  await page.getByLabel('Undo').click();
  await expect(page.locator('rect[style*="move"]').first()).toHaveAttribute(
    'width',
    '200'
  );
});

test('toolbar validate calls the server validation endpoint', async ({
  page
}) => {
  await open(page, {
    path: '/cabinets/cab-1/design',
    feature: 'RenderCabinetDesigner'
  });
  await expect(page.getByTestId('cabinet-designer')).toBeVisible();

  await page.getByLabel('Validate layout').click();
  await expect(page.getByText(/Server validation: 0 error/)).toBeVisible();

  const posts = (await recordedCalls(page)).filter((call) =>
    call.url.endsWith('/validate-layout/')
  );
  expect(posts).toHaveLength(1);
});

test('a stale save surfaces the conflict dialog and keeps the draft', async ({
  page
}) => {
  await open(page, {
    path: '/cabinets/cab-1/design',
    feature: 'RenderCabinetDesigner'
  });
  await expect(page.getByTestId('cabinet-designer')).toBeVisible();

  await dragFirstDrawer(page, 30, 0);
  await expect(page.locator('rect[style*="move"]').first()).toHaveAttribute(
    'x',
    '40'
  );

  // Force the next write to be rejected as stale.
  await page.evaluate(() =>
    (
      window as unknown as { __mock: { setNextSaveStatus: (s: number) => void } }
    ).__mock.setNextSaveStatus(412)
  );

  await page.getByLabel('Save layout').click();
  await expect(
    page.getByText('Save conflict (stale revision)')
  ).toBeVisible();
  // The draft is retained (unsaved) after the conflict.
  await expect(page.getByText('Unsaved changes')).toBeVisible();
  await expect(page.locator('rect[style*="move"]').first()).toHaveAttribute(
    'x',
    '40'
  );
});

test('drawer designer generates a bin grid without overwriting existing bins', async ({
  page
}) => {
  await open(page, {
    path: '/drawers/drawer-1/design',
    feature: 'RenderDrawerDesigner'
  });
  await expect(page.getByTestId('drawer-designer')).toBeVisible();
  await expect(page.getByTestId('bin-list')).toBeVisible();
  await expect(page.getByTestId('bin-list').getByRole('button')).toHaveCount(1);

  await page.getByLabel('Generate bin grid').click();
  await expect(page.getByText('Generate bin grid')).toBeVisible();
  await page.getByRole('button', { name: 'Generate', exact: true }).click();

  // 7 of the 8 default cells are placed; the 8th collides with the existing bin.
  await expect(page.getByTestId('bin-list').getByRole('button')).toHaveCount(8);
  await expect(page.getByTestId('bin-list').getByText('B-01')).toBeVisible();

  await page.getByLabel('Save layout').click();
  const puts = (await recordedCalls(page)).filter((call) => call.method === 'PUT');
  expect(puts).toHaveLength(1);
  expect(puts[0].body.bins.length).toBe(8);
  expect(
    puts[0].body.bins.some((bin: { label: string }) => bin.label === 'A1-01')
  ).toBe(true);
});

test('simulation diagnostics run a locate session and show the plan', async ({
  page
}) => {
  await open(page, {
    path: '/cabinets/cab-1/design',
    feature: 'RenderCabinetDesigner'
  });
  await expect(page.getByTestId('cabinet-designer')).toBeVisible();

  // Select a drawer so the simulation panel targets it.
  await page.getByTestId('drawer-list').getByRole('button').first().click();

  await page.getByRole('tab', { name: 'Diagnostics' }).click();
  await expect(page.getByTestId('simulation-panel')).toBeVisible();
  await expect(page.getByText('SIMULATION', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Locate' }).click();

  await expect(page.getByTestId('session-status')).toBeVisible();
  await expect(page.getByTestId('session-status')).toContainText('active');
  await expect(page.getByTestId('session-plan-runs')).toBeVisible();

  // The locate request was a POST to the session endpoint, never a socket.
  const posts = (await recordedCalls(page)).filter((call) =>
    call.url.endsWith('/locate-sessions/')
  );
  expect(posts).toHaveLength(1);
});

test('diagnostics submit an explicitly bounded walking pixel test', async ({ page }) => {
  await open(page, { path: '/cabinets/cab-1/design', feature: 'RenderCabinetDesigner' });
  await page.getByRole('tab', { name: 'Diagnostics' }).click();
  await page.getByLabel('Start', { exact: true }).fill('1');
  await page.getByLabel('End', { exact: true }).fill('3');
  await page.getByRole('combobox', { name: 'Test pattern', exact: true }).click();
  await page.getByRole('option', { name: 'Walk (maximum 32 pixels)', exact: true }).click();
  await page.getByRole('button', { name: 'Run pixel test', exact: true }).click();
  await expect(page.getByTestId('session-status')).toBeVisible();
  const calls = (await recordedCalls(page)).filter((call) => call.url.endsWith('/pixel-tests/'));
  expect(calls).toHaveLength(1);
  expect(calls[0].body).toMatchObject({ pattern: 'walk', logical_start: 1, logical_end: 3, mode: 'simulate' });
});

test('mapping panel previews and publishes a candidate mapping', async ({
  page
}) => {
  await open(page, {
    path: '/cabinets/cab-1/design',
    feature: 'RenderCabinetDesigner'
  });
  await expect(page.getByTestId('cabinet-designer')).toBeVisible();

  await page.getByRole('tab', { name: 'Mapping' }).click();
  await expect(page.getByTestId('mapping-panel')).toBeVisible();

  const panel = page.getByTestId('mapping-panel');
  await panel.getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByTestId('translation-sample')).toBeVisible();

  await panel.getByRole('button', { name: 'Publish mapping' }).click();
  await expect(page.getByText(/Published mapping revision 2/)).toBeVisible();
  await expect(page.getByTestId('publish-result')).toContainText(
    '1 physical pixel(s) changed'
  );

  const publish = (await recordedCalls(page)).filter((call) =>
    call.url.endsWith('/mapping-publish/')
  );
  expect(publish).toHaveLength(1);
  expect(publish[0].headers?.['If-Match']).toBe('"3"');
});

test('saved topology reaches Mapping with the new ETag without a page reload', async ({ page }) => {
  await open(page, { path: '/cabinets/cab-1/design', feature: 'RenderCabinetDesigner' });
  await page.getByRole('tab', { name: 'Topology', exact: true }).click();
  const topology = page.getByTestId('topology-editor');
  await topology.getByLabel('Name', { exact: true }).fill('Renamed controller');
  await topology.getByRole('button', { name: 'Save topology' }).click();
  await expect(topology.getByText('Electrical topology saved.')).toBeVisible();
  await page.getByRole('tab', { name: 'Mapping', exact: true }).click();
  const mapping = page.getByTestId('mapping-panel');
  await expect(mapping.getByRole('combobox').first()).toHaveValue('Renamed controller/S1');
  await mapping.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByTestId('translation-sample')).toBeVisible();
  await mapping.getByRole('button', { name: 'Publish mapping' }).click();
  await expect(page.getByTestId('publish-result')).toBeVisible();
  await expect(page.getByTestId('publish-stale')).toHaveCount(0);
  const publish = (await recordedCalls(page)).filter((call) => call.url.endsWith('/mapping-publish/'));
  expect(publish).toHaveLength(1);
  expect(publish[0].headers?.['If-Match']).toBe('"4"');
});

test('function colours panel loads, saves and creates profiles', async ({
  page
}) => {
  await open(page, {
    path: '/cabinets/cab-1/design',
    feature: 'RenderCabinetDesigner'
  });
  await expect(page.getByTestId('cabinet-designer')).toBeVisible();

  await page.getByRole('tab', { name: 'Colors' }).click();
  await expect(page.getByTestId('function-colors-panel')).toBeVisible();
  await expect(page.getByTestId('profile-row-profile-1')).toBeVisible();
  await expect(page.getByTestId('profile-swatch-profile-1')).toHaveCSS(
    'background-color',
    'rgb(0, 255, 0)'
  );

  // Edit the red channel and save through the API.
  const row = page.getByTestId('profile-row-profile-1');
  await row.getByLabel('Red').fill('12');
  await row.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('function-colors-message')).toBeVisible();

  const patch = (await recordedCalls(page)).filter(
    (call) => call.method === 'PATCH' && call.url.includes('/profiles/profile-1/')
  );
  expect(patch).toHaveLength(1);
  expect(patch[0].body).toMatchObject({ rgb_r: 12 });

  // Create a new function colour.
  const panel = page.getByTestId('function-colors-panel');
  await panel.getByLabel('Name', { exact: true }).fill('Test blue');
  await panel.getByRole('button', { name: 'Create' }).click();

  const created = (await recordedCalls(page)).filter(
    (call) => call.method === 'POST' && call.url.endsWith('/profiles/')
  );
  expect(created).toHaveLength(1);
  expect(created[0].body).toMatchObject({ cabinet: 'cab-1', name: 'Test blue' });
});
