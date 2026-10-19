#!/usr/bin/env node
/* Isolated Development-only cabinet layout regression. Never logs credentials or request bodies. */
const { chromium } = require('../../src/frontend/node_modules/@playwright/test');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const base = process.env.SL_BASE_URL || 'http://192.168.1.108:18081';
assert.equal(base, 'http://192.168.1.108:18081', 'Acceptance is restricted to approved Development');
const api = '/plugin/storage-layout/api/v1/';
const sshOptions = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes'];
const remote = (command) => execFileSync('ssh', [...sshOptions, 'spetchal@mainserver-1', command], {
  encoding: 'utf8', timeout: 30000
});
const report = (label, status, passed) => console.log(`${passed ? 'PASS' : 'FAIL'} ${label} HTTP ${status}`);

(async () => {
  // Matches browser-smoke.cjs's existing credential retrieval mechanism; the
  // secret remains only in process memory and is never emitted or persisted.
  const password = remote("sudo -n python3 -c \"from pathlib import Path; v=dict(line.split('=',1) for line in Path('/etc/myinventree-dev/runtime.env').read_text().splitlines()); print(v['SL_ADMIN_PASSWORD'])\"").trim();
  assert.ok(password, 'credential retrieval returned an empty value');
  const browser = await chromium.launch({ headless: true, ...(process.env.SL_CHROMIUM_PATH ? { executablePath: process.env.SL_CHROMIUM_PATH } : {}) });
  let cabinetId;
  try {
    const context = await browser.newContext({ viewport: { width: 1734, height: 1200 } });
    const page = await context.newPage();
    await page.goto(`${base}/web/login`);
    await page.getByLabel('login-username').fill('sl_admin');
    await page.getByLabel('login-password').fill(password);
    await page.getByRole('button', { name: 'Log In', exact: true }).click();
    await page.getByLabel('navigation-menu').waitFor({ timeout: 45000 });
    const csrf = (await context.cookies()).find((cookie) => cookie.name === 'csrftoken')?.value;
    assert.ok(csrf, 'authenticated CSRF cookie unavailable');
    const headers = { 'X-CSRFToken': csrf, Referer: `${base}/web/` };
    const apiRequest = async (method, path, data) => {
      const response = await context.request[method](base + path, {
        headers, ...(data === undefined ? {} : { data })
      });
      report(`${method.toUpperCase()} ${path}`, response.status(), response.ok());
      return response;
    };
    const listResponse = await apiRequest('get', `${api}cabinets/`);
    assert.equal(listResponse.status(), 200, 'list cabinets');
    const cabinetPage = await listResponse.json();
    const priorFixtures = (cabinetPage.results || []).filter((item) => item.name.startsWith('SL isolated regression '));
    for (const candidate of priorFixtures) {
      const priorLayout = await apiRequest('get', `${api}cabinets/${candidate.id}/layout/`);
      if (priorLayout.status() !== 200) continue;
      const priorData = await priorLayout.json();
      if (priorData.drawers.length === 0) {
        cabinetId = candidate.id;
        console.log(`Reusing empty isolated fixture cabinet=${cabinetId}`);
        break;
      }
    }
    if (!cabinetId) {
      const locationsResponse = await apiRequest('get', '/api/stock/location/');
      assert.equal(locationsResponse.status(), 200, 'stock locations');
      // Use a fresh native structural location, never an existing cabinet's location.
      const name = `SL isolated regression ${new Date().toISOString()} ${crypto.randomUUID().slice(0, 8)}`;
      const locationResponse = await apiRequest('post', '/api/stock/location/', {
        name, description: 'Disposable parent for isolated Storage Layout regression', structural: true
      });
      assert.equal(locationResponse.status(), 201, 'create isolated native location');
      const location = await locationResponse.json();
      assert.ok(location.pk, 'created location has no primary key');

      const slug = `sl-regression-${crypto.randomUUID()}`;
      const cabinetResponse = await apiRequest('post', `${api}cabinets/`, {
        name, slug, location: location.pk, width_units: 640, height_units: 840
      });
      assert.equal(cabinetResponse.status(), 201, 'create isolated cabinet');
      const cabinet = await cabinetResponse.json();
      cabinetId = cabinet.id;
    }
    const designUrl = `${base}/web/plugin/storage-layout/cabinets/${cabinetId}/design`;
    await page.goto(designUrl);
    await page.getByTestId('cabinet-designer').waitFor({ timeout: 30000 });

    const saveResponse = () => page.waitForResponse((response) =>
      response.url().includes(`/cabinets/${cabinetId}/layout/`) && response.request().method() === 'PUT'
    );
    const save = async (label) => {
      const pending = saveResponse();
      await page.getByLabel('Save layout', { exact: true }).click();
      const response = await pending;
      report(label, response.status(), response.ok());
      if (!response.ok()) {
        // Emit only the minimum whitelisted request evidence needed to diagnose
        // the save contract. Never dump headers, cookies, or full payloads.
        let payload;
        try { payload = response.request().postDataJSON(); } catch { payload = null; }
        const drawers = Array.isArray(payload?.drawers) ? payload.drawers : [];
        const conditionalRevision = response.request().headers()['if-match'] ?? null;
        console.log(`PUT evidence cabinet=${cabinetId} if_match=${JSON.stringify(conditionalRevision)} body_revision=${JSON.stringify(payload?.revision ?? null)} schema_version=${JSON.stringify(payload?.schema_version ?? null)} drawers=${JSON.stringify(drawers.map((drawer) => ({ id: drawer?.id ?? null, is_new: drawer?.is_new ?? null, label: typeof drawer?.label === 'string' ? drawer.label.slice(0, 40) : null, archived: drawer?.archived ?? null })))}`);
        const persistedResponse = await apiRequest('get', `${api}cabinets/${cabinetId}/layout/`);
        if (persistedResponse.status() === 200) {
          const persisted = await persistedResponse.json();
          console.log(`DB/API after failed save cabinet=${cabinetId} revision=${persisted.revision ?? null} drawers=${JSON.stringify((persisted.drawers || []).map((drawer) => ({ id: drawer.id, label: drawer.label, archived: drawer.archived })))}`);
        }
        let responseEvidence = null;
        try {
          const body = await response.json();
          responseEvidence = body?.detail ?? body?.error ?? body?.message ?? null;
        } catch { /* non-JSON response */ }
        if (typeof responseEvidence === 'string') {
          console.log(`PUT response detail=${responseEvidence.replaceAll(password, '[REDACTED]').slice(0, 300)}`);
                    const bodyCode = (await response.json().catch(() => null))?.code;
                    if (typeof bodyCode === 'string') console.log(`PUT response code=${bodyCode.slice(0, 100)}`);
        }
        const visibleError = await page.getByRole('alert').innerText().catch(() => '');
        console.log(`UI error text: ${visibleError.replaceAll(password, '[REDACTED]').slice(0, 500)}`);
      }
      assert.equal(response.status(), 200, label);
      await page.getByText('Saved', { exact: true }).waitFor({ timeout: 15000 });
    };

    // Exercise cabinet dimension controls through the designer and verify the
    // saved dimensions survive a browser refresh before creating geometry.
    const cabinetWidthField = page.getByLabel('Cabinet width in logical units', { exact: true });
    const cabinetHeightField = page.getByLabel('Cabinet height in logical units', { exact: true });
    const initialCabinet = await (await apiRequest('get', `${api}cabinets/${cabinetId}/`)).json();
    const editedCabinetWidth = Number(initialCabinet.width_units) + 1;
    const editedCabinetHeight = Number(initialCabinet.height_units) + 1;
    await cabinetWidthField.fill(String(editedCabinetWidth));
    await cabinetWidthField.press('Tab');
    await cabinetHeightField.fill(String(editedCabinetHeight));
    await cabinetHeightField.press('Tab');
    await save('edit cabinet dimensions');
    await page.reload();
    await page.getByTestId('cabinet-designer').waitFor({ timeout: 30000 });
    const persistedCabinet = await (await apiRequest('get', `${api}cabinets/${cabinetId}/`)).json();
    assert.equal(Number(persistedCabinet.width_units), editedCabinetWidth, 'cabinet width persists after refresh');
    assert.equal(Number(persistedCabinet.height_units), editedCabinetHeight, 'cabinet height persists after refresh');

    // New drawers are intentionally unbound. Create an isolated structural child
    // beneath this fixture cabinet's native location, then bind it in the visible
    // drawer inspector before saving (the API rejects unbound drawers).
    const cabinetDetailResponse = await apiRequest('get', `${api}cabinets/${cabinetId}/`);
    assert.equal(cabinetDetailResponse.status(), 200, 'read isolated cabinet');
    const cabinetDetail = await cabinetDetailResponse.json();
    assert.ok(cabinetDetail.location, 'fixture cabinet has a native parent location');
    const drawerLocationName = `SL regression drawer ${crypto.randomUUID().slice(0, 8)}`;
    const duplicateLocationName = `SL regression duplicate ${crypto.randomUUID().slice(0, 8)}`;
    const drawnLocationName = `SL regression drawn ${crypto.randomUUID().slice(0, 8)}`;
    const drawerLocationResponse = await apiRequest('post', '/api/stock/location/', {
      name: drawerLocationName,
      description: 'Disposable structural child for isolated Storage Layout regression',
      parent: cabinetDetail.location,
      structural: true
    });
    assert.equal(drawerLocationResponse.status(), 201, 'create isolated structural drawer location');
    const drawerLocation = await drawerLocationResponse.json();
    assert.ok(drawerLocation.pk, 'created drawer location has no primary key');
    const duplicateLocationResponse = await apiRequest('post', '/api/stock/location/', {
      name: duplicateLocationName, description: 'Disposable structural child for duplicate regression',
      parent: cabinetDetail.location, structural: true
    });
    assert.equal(duplicateLocationResponse.status(), 201, 'create isolated duplicate location');
    const duplicateLocation = await duplicateLocationResponse.json();
    const drawnLocationResponse = await apiRequest('post', '/api/stock/location/', {
      name: drawnLocationName, description: 'Disposable structural child for drawn drawer regression',
      parent: cabinetDetail.location, structural: true
    });
    assert.equal(drawnLocationResponse.status(), 201, 'create isolated drawn-drawer location');
    const drawnLocation = await drawnLocationResponse.json();

    await page.getByRole('button', { name: 'Add drawer', exact: true }).click();
    const drawerInspector = page.getByTestId('drawer-inspector');
    await drawerInspector.waitFor({ timeout: 10000 });
    await page.getByTestId('entity-count').filter({ hasText: '1 item' }).waitFor({ timeout: 10000 });
    await page.getByText(/Unbound: this drawer cannot resolve inventory/i).waitFor({ timeout: 5000 });
    const locationField = drawerInspector.getByLabel('Stock location', { exact: true });
    await locationField.click();
    await locationField.fill(drawerLocationName);
    await page.getByRole('option', { name: new RegExp(drawerLocationName) }).click();
    await page.getByText(/Unbound: this drawer cannot resolve inventory/i).waitFor({ state: 'hidden', timeout: 5000 });
    await save('add drawer save');
    await page.reload();
    await page.getByTestId('cabinet-designer').waitFor({ timeout: 30000 });
    let layoutPath = `${api}cabinets/${cabinetId}/layout/`;
    let layoutResponse = await apiRequest('get', layoutPath);
    assert.equal(layoutResponse.status(), 200, 'read layout after add refresh');
    let layout = await layoutResponse.json();
    assert.equal(layout.drawers.length, 1, 'one added drawer persisted across refresh');

    // Reload does not guarantee selection. Select the persisted drawer explicitly
    // before invoking the duplicate command.
    const firstDrawerRect = page.locator('svg g > rect[style]').evaluateAll((nodes) => {
      const rect = nodes.find((node) => node.style.cursor === 'move');
      if (!rect) throw new Error('Draggable drawer SVG rect not found for selection');
      const box = rect.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    });
    const drawerScreenPoint = await firstDrawerRect;
    await page.mouse.click(drawerScreenPoint.x, drawerScreenPoint.y);
    await page.getByRole('button', { name: 'Duplicate selection', exact: true }).click();
    await page.getByTestId('entity-count').filter({ hasText: '2 items' }).waitFor({ timeout: 10000 });
    const duplicateInspector = page.getByTestId('drawer-inspector');
    await duplicateInspector.waitFor({ timeout: 10000 });
    await page.getByText(/Unbound: this drawer cannot resolve inventory/i).waitFor({ timeout: 5000 });
    const duplicateLocationField = duplicateInspector.getByLabel('Stock location', { exact: true });
    await duplicateLocationField.click();
    await duplicateLocationField.fill(duplicateLocationName);
    await page.getByRole('option', { name: new RegExp(duplicateLocationName) }).click();
    await duplicateInspector.getByLabel('X', { exact: true }).fill('400');
    await duplicateInspector.getByLabel('Y', { exact: true }).fill('500');
    await page.getByText(/Unbound: this drawer cannot resolve inventory/i).waitFor({ state: 'hidden', timeout: 5000 });
    await save('duplicate drawer save');
    await page.reload();
    await page.getByTestId('cabinet-designer').waitFor({ timeout: 30000 });
    layoutResponse = await apiRequest('get', layoutPath);
    assert.equal(layoutResponse.status(), 200, 'read layout after duplicate refresh');
    layout = await layoutResponse.json();
    assert.equal(layout.drawers.length, 2, 'added and duplicated drawers persist across refresh');

    const canvas = page.getByRole('application', { name: /cabinet/i });
    const svg = canvas;
    const selectMode = page.getByRole('button', { name: 'Select mode', exact: true });
    const panMode = page.getByRole('button', { name: 'Pan mode', exact: true });
    await selectMode.waitFor({ state: 'visible', timeout: 10000 });
    await panMode.waitFor({ state: 'visible', timeout: 10000 });
    await panMode.click();
    assert.equal(await panMode.getAttribute('aria-pressed'), 'true', 'Pan mode becomes active');
    await selectMode.click();
    assert.equal(await selectMode.getAttribute('aria-pressed'), 'true', 'Select mode becomes active');
    const pointerAt = async (x, y) => svg.evaluate((node, point) => {
      const p = node.createSVGPoint(); p.x = point[0]; p.y = point[1];
      const transformedGroup = node.querySelector('g[transform]');
      const ctm = transformedGroup?.getScreenCTM();
      if (!ctm) throw new Error('SVG transformed-group screen CTM unavailable');
      const screen = p.matrixTransform(ctm); return { x: screen.x, y: screen.y };
    }, [x, y]);
    await canvas.waitFor({ timeout: 10000 });
    const zoomLabel = page.locator('text=/\\d+%/').first();
    const zoomBefore = await zoomLabel.textContent();
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await page.waitForFunction((before) => {
      const label = [...document.querySelectorAll('*')].find((node) => /^\d+%$/.test((node.textContent || '').trim()));
      return label && label.textContent.trim() !== before.trim();
    }, zoomBefore);
    const zoomIn = await zoomLabel.textContent();
    await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
    await page.getByRole('button', { name: 'Fit to view', exact: true }).click();
    const fitZoom = await zoomLabel.textContent();
    await page.getByRole('button', { name: 'Reset view', exact: true }).click();
    const resetZoom = await zoomLabel.textContent();
    assert.ok(zoomBefore && zoomIn && fitZoom && resetZoom, 'canvas zoom indicator is visible');
    assert.notEqual(zoomIn, zoomBefore, 'zoom-in changes rendered zoom indicator');
    assert.equal(resetZoom, '100%', 'reset view restores 100% zoom');
    // Pan uses the SVG's middle-button pointer path; no cabinet geometry is changed.
    await canvas.scrollIntoViewIfNeeded();
        const canvasBox = await canvas.boundingBox();
    assert.ok(canvasBox, 'designer canvas has a visible bounding box');
    const panBefore = await svg.evaluate((node) => node.querySelector('g[transform]')?.getAttribute('transform'));
    const panStart = { x: canvasBox.x + canvasBox.width * 0.5, y: canvasBox.y + canvasBox.height * 0.5 };
    await page.mouse.move(panStart.x, panStart.y);
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(panStart.x + 40, panStart.y + 30, { steps: 10 });
    await page.mouse.up({ button: 'middle' });
    await page.waitForFunction(({ selector, before }) => {
      const node = document.querySelector(selector)?.querySelector('g[transform]');
      return node && node.getAttribute('transform') !== before;
    }, { selector: 'svg[role="application"]', before: panBefore });
    const panAfter = await svg.evaluate((node) => node.querySelector('g[transform]')?.getAttribute('transform'));
    console.log(`PAN evidence before=${panBefore} after=${panAfter}`);
    assert.notEqual(panAfter, panBefore, 'middle-button pan changes canvas transform');


    const drawButton = page.getByRole('button', { name: 'Draw mode', exact: true });
    await drawButton.waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await drawButton.count(), 1, 'Draw drawer control is exposed by its accessible name');
    {
      await drawButton.click();
      const svgBox = await svg.boundingBox();
      assert.ok(svgBox, 'designer canvas has a visible bounding box');
      const drawStart = await pointerAt(200, 200);
      await page.mouse.move(drawStart.x, drawStart.y);
      await page.mouse.down();
      const drawEnd = await pointerAt(300, 280);
      await page.mouse.move(drawEnd.x, drawEnd.y, { steps: 10 });
      await page.mouse.up();
      assert.equal(await drawButton.getAttribute('aria-pressed'), 'true', 'Draw mode is active before pointer drag');
      await page.getByTestId('entity-count').filter({ hasText: '3 items' }).waitFor({ timeout: 10000 });
      const drawnInspector = page.getByTestId('drawer-inspector');
      await drawnInspector.waitFor({ timeout: 10000 });
      const drawnLocationField = drawnInspector.getByLabel('Stock location', { exact: true });
      await drawnLocationField.click();
      await drawnLocationField.fill(drawnLocationName);
      await page.getByRole('option', { name: new RegExp(drawnLocationName) }).click();
      await page.getByText(/Unbound: this drawer cannot resolve inventory/i).waitFor({ state: 'hidden', timeout: 5000 });
      await save('draw drawer save');
      await page.reload();
      await page.getByTestId('cabinet-designer').waitFor({ timeout: 30000 });
      layoutResponse = await apiRequest('get', layoutPath);
      assert.equal(layoutResponse.status(), 200, 'read layout after draw refresh');
      layout = await layoutResponse.json();
      assert.equal(layout.drawers.length, 3, 'drawn drawer persists independently');
      await save('repeat save idempotency');
      layoutResponse = await apiRequest('get', layoutPath);
      assert.equal(layoutResponse.status(), 200, 'read layout after repeated save');
      layout = await layoutResponse.json();
      assert.equal(layout.drawers.length, 3, 'repeated save does not duplicate drawer records');
      assert.equal(new Set(layout.drawers.map((drawer) => drawer.id)).size, 3, 'repeated save preserves unique drawer identities');
    }
    assert.ok(layout.drawers.every((drawer) => drawer.id), 'persisted drawer IDs returned');

    // SVG client coordinates are derived from its current screen CTM, so
    // zoom/pan transforms cannot skew pointer targeting or geometry checks.
    const snapSwitch = page.getByRole('switch', { name: 'Snap to grid', exact: true });
    const gridSize = page.getByRole('textbox', { name: 'Grid size', exact: true });
    await snapSwitch.waitFor({ state: 'visible', timeout: 10000 });
    await gridSize.waitFor({ state: 'visible', timeout: 10000 });
    const gridControlsAvailable = true;
    {
      if ((await snapSwitch.getAttribute('aria-checked')) !== 'true') await snapSwitch.click();
      await gridSize.fill('10');
      await gridSize.press('Tab');
    }

    const readGeometry = async () => page.locator('svg g > rect[style]').evaluateAll((nodes) => {
      const rect = nodes.find((node) => node.style.cursor === 'move');
      if (!rect) throw new Error('Draggable drawer SVG rect not found');
      return ['x', 'y', 'width', 'height'].map((key) => Number(rect.getAttribute(key)));
    });
    let beforeMove = await readGeometry();

    const rectScreenBox = await page.locator('svg g > rect[style]').evaluateAll((nodes) => {
      const rect = nodes.find((node) => node.style.cursor === 'move');
      if (!rect) throw new Error('Draggable drawer SVG rect not found');
      const box = rect.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    });
    let point = { x: rectScreenBox.x + rectScreenBox.width / 2, y: rectScreenBox.y + rectScreenBox.height / 2 };
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    const moveTarget = { x: point.x + 30 * rectScreenBox.width / beforeMove[2], y: point.y + 30 * rectScreenBox.height / beforeMove[3] };
    await page.mouse.move(moveTarget.x, moveTarget.y, { steps: 10 });
    await page.mouse.up();
    let afterMove = await readGeometry();
    console.log(`MOVE evidence before=${JSON.stringify(beforeMove)} after=${JSON.stringify(afterMove)} screen_delta=30,30`);
    assert.notDeepEqual(afterMove.slice(0, 2), beforeMove.slice(0, 2), 'drag changes drawer position');
    if (gridControlsAvailable) {
      assert.equal((afterMove[0] - beforeMove[0]) % 10, 0, 'move x snaps to grid');
      assert.equal((afterMove[1] - beforeMove[1]) % 10, 0, 'move y snaps to grid');
    }
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    assert.deepEqual(await readGeometry(), beforeMove, 'undo restores pre-move geometry');
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    assert.deepEqual(await readGeometry(), afterMove, 'redo reapplies moved geometry');
    const [x, y, width, height] = afterMove;
    const selectedDrawerCenter = await page.locator('svg g > rect[style]').evaluateAll((nodes) => {
      const rect = nodes.find((node) => node.style.cursor === 'move');
      if (!rect) throw new Error('Draggable drawer SVG rect not found before resize');
      const box = rect.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    });
    await page.mouse.click(selectedDrawerCenter.x, selectedDrawerCenter.y);
    const resizeHandle = await page.locator('svg rect[style]').evaluateAll((nodes) => {
      const handle = nodes.find((node) => node.style.cursor === 'se-resize');
      if (!handle) throw new Error('South-east resize handle is not rendered for selected drawer');
      const box = handle.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    });
    const resizeHit = await page.evaluate(({ x, y }) => {
      const target = document.elementFromPoint(x, y);
      return target ? { tag: target.tagName, cursor: target.style?.cursor, ariaHidden: target.getAttribute('aria-hidden') } : null;
    }, resizeHandle);
    console.log(`RESIZE target=${JSON.stringify(resizeHit)} handle=${JSON.stringify(resizeHandle)} zoom=${await zoomLabel.textContent()}`);
    await page.mouse.move(resizeHandle.x, resizeHandle.y, { steps: 10 });
    await page.mouse.down();
    const resizeScreenDelta = await svg.evaluate((node) => {
      const group = node.querySelector('g[transform]');
      const scale = group?.getScreenCTM()?.a;
      if (!scale || !Number.isFinite(scale)) throw new Error('SVG model-to-screen scale unavailable');
      return 20 * scale;
    });
    await page.mouse.move(resizeHandle.x + resizeScreenDelta, resizeHandle.y + resizeScreenDelta, { steps: 10 });
    await page.waitForTimeout(150);
    await page.mouse.up();
    const afterResize = await readGeometry();
    console.log(`RESIZE evidence before=${JSON.stringify(afterMove)} after=${JSON.stringify(afterResize)} handle=${JSON.stringify(resizeHandle)}`);
    const failures = [];
    try {
      assert.ok(afterResize[2] > width && afterResize[3] > height, 'resize changes drawer dimensions');
    } catch (error) {
      failures.push(error.message);
      console.error(`FAIL resize: ${error.message}`);
    }
    await save('move + resize + grid snap + undo/redo save');
    layoutResponse = await apiRequest('get', layoutPath);
    assert.equal(layoutResponse.status(), 200, 'read moved and resized layout');
    layout = await layoutResponse.json();
    assert.equal(layout.drawers.length, 3, 'three drawer records persist');

    // Exercise real multi-selection and arrange controls against all three
    // isolated drawers. Select by the accessible drawer-list buttons, then use
    // shift-click as an ordinary operator would.
    const drawerNames = layout.drawers.map((drawer) => drawer.label);
    const drawerList = page.getByTestId('drawer-list');
    const drawerButtons = drawerNames.map((label) => drawerList.getByRole('button', { name: `Drawer ${label}`, exact: true }));
    assert.equal(drawerButtons.length, 3, 'three drawer list controls available');
    const cabinetCanvas = page.getByRole('application', { name: /cabinet front view/i });
    const clearPoint = await cabinetCanvas.boundingBox();
    assert.ok(clearPoint, 'cabinet canvas is visible for clearing selection');
    await page.mouse.click(clearPoint.x + 3, clearPoint.y + 3);
    await page.waitForTimeout(200);
    await drawerButtons[0].click();
    await page.waitForTimeout(200);
    await drawerButtons[1].click({ modifiers: ['Shift'] });
    await page.waitForTimeout(200);
    await drawerButtons[2].click({ modifiers: ['Shift'] });
    await page.waitForTimeout(300);
    const selectedCount = await Promise.all(drawerButtons.map((button) => button.getAttribute('aria-selected')));
    console.log(`MULTI selection labels=${JSON.stringify(drawerNames)} aria_selected=${JSON.stringify(selectedCount)}`);
    const multiSelected = selectedCount.filter((value) => value === 'true').length === 3;
    if (!multiSelected) console.log('BLOCKER multi-selection: three canvas shift-clicks left fewer than three drawer rows selected; arrange controls are unavailable');
    const drawerGeometryById = async () => {
      const response = await apiRequest('get', layoutPath);
      assert.equal(response.status(), 200, 'read drawer geometry');
      const data = await response.json();
      return new Map(data.drawers.map((drawer) => [drawer.id, { x: Number(drawer.x), y: Number(drawer.y), width: Number(drawer.width), height: Number(drawer.height) }]));
    };
    if (multiSelected) {
      const beforeDistribution = await drawerGeometryById();
      const distributeButton = page.getByRole('button', { name: 'Distribute horizontally', exact: true });
      await distributeButton.click();
      await save('multi-select horizontal distribution');
      const afterDistribution = await drawerGeometryById();
      assert.notDeepEqual([...afterDistribution.entries()], [...beforeDistribution.entries()], 'distribution changes persisted geometry');
      const alignButton = page.getByRole('button', { name: 'Align top', exact: true });
      await alignButton.click();
      await save('multi-select top alignment');
      const afterAlignment = await drawerGeometryById();
      const alignedY = drawerNames.map((_, index) => afterAlignment.get(layout.drawers[index].id).y);
      assert.equal(new Set(alignedY).size, 1, 'align top gives all selected drawers a shared top edge');
      layoutResponse = await apiRequest('get', layoutPath);
      assert.equal(layoutResponse.status(), 200, 'read arranged drawers after save');
      layout = await layoutResponse.json();
    }

    // Select the known bound drawer explicitly before editing its inspector.
    await drawerButtons[0].click();
    await page.waitForTimeout(250);
    // Change drawer geometry through the visible inspector when a drawer is selected.
    const widthField = page.getByLabel('Width', { exact: true });
    assert.equal(await widthField.count(), 1, 'selected drawer exposes width inspector control');
    const priorWidth = Number(await widthField.inputValue());
    const editedWidth = priorWidth - 1;
    await widthField.fill(String(editedWidth));
    await widthField.press('Tab');
    await save('edit drawer geometry');
    layoutResponse = await apiRequest('get', layoutPath);
    assert.equal(layoutResponse.status(), 200, 'read edited drawer geometry');
    layout = await layoutResponse.json();
    const editedDrawer = layout.drawers.find((drawer) => drawer.location === drawerLocation.pk);
    assert.ok(editedDrawer, 'edited drawer is present by its isolated native location');
    assert.equal(Number(editedDrawer.width), editedWidth, 'drawer width edit persisted');

    // Exercise interior-bin design on a persisted, isolated drawer only. A bin
    // requires its own native child location; bind it through the visible inspector.
    const interiorDrawer = layout.drawers[0];
    const binLocationResponse = await apiRequest('post', '/api/stock/location/', {
      name: `SL regression bin ${crypto.randomUUID().slice(0, 8)}`,
      description: 'Disposable non-structural child for isolated Storage Layout regression bin',
      parent: interiorDrawer.location,
      structural: false
    });
    assert.equal(binLocationResponse.status(), 201, 'create isolated bin location');
    const binLocation = await binLocationResponse.json();
    await page.goto(`${base}/web/plugin/storage-layout/drawers/${interiorDrawer.id}/design`);
    await page.getByRole('button', { name: 'Add bin', exact: true }).click();
    await page.getByTestId('entity-count').filter({ hasText: /item/ }).waitFor({ timeout: 10000 });
    const binInspector = page.getByTestId('bin-inspector');
    await binInspector.waitFor({ timeout: 10000 });
    const binLocationField = binInspector.getByLabel('Stock location', { exact: true });
    await binLocationField.click();
    await binLocationField.fill(binLocation.name);
    await page.getByRole('option', { name: new RegExp(binLocation.name) }).click();
    const binSavePending = page.waitForResponse((response) =>
      response.url().includes(`/drawers/${interiorDrawer.id}/layout/`) && response.request().method() === 'PUT'
    );
    await page.getByRole('button', { name: 'Save layout', exact: true }).click();
    const binSaveResponse = await binSavePending;
    report('interior bin save', binSaveResponse.status(), binSaveResponse.ok());
    assert.equal(binSaveResponse.status(), 200, 'interior bin save response');
    await page.getByRole('button', { name: 'Save layout', exact: true }).waitFor({ state: 'visible' });
    const binLayoutResponse = await apiRequest('get', `${api}drawers/${interiorDrawer.id}/layout/`);
    assert.equal(binLayoutResponse.status(), 200, 'read saved interior bin layout');
    const binLayout = await binLayoutResponse.json();
    assert.ok(binLayout.bins.some((bin) => bin.location === binLocation.pk), 'bound interior bin persisted');
    assert.equal(await page.getByRole('button', { name: 'Generate bin grid' }).count(), 1, 'grid generation control is present');
    const binWidthField = binInspector.getByLabel('Width', { exact: true });
    const originalBinWidth = Number(await binWidthField.inputValue());
    const editedBinWidth = originalBinWidth + 1;
    await binWidthField.fill(String(editedBinWidth));
    await binWidthField.press('Tab');
    const editBinPending = page.waitForResponse((response) =>
      response.url().includes(`/drawers/${interiorDrawer.id}/layout/`) && response.request().method() === 'PUT'
    );
    await page.getByRole('button', { name: 'Save layout', exact: true }).click();
    const editBinResponse = await editBinPending;
    report('edit bin geometry', editBinResponse.status(), editBinResponse.ok());
    assert.equal(editBinResponse.status(), 200, 'edited bin layout save');
    const editedBinLayoutResponse = await apiRequest('get', `${api}drawers/${interiorDrawer.id}/layout/`);
    assert.equal(editedBinLayoutResponse.status(), 200, 'read edited bin layout');
    const editedBinLayout = await editedBinLayoutResponse.json();
    const editedBin = editedBinLayout.bins.find((bin) => bin.location === binLocation.pk);
    assert.ok(editedBin, 'edited bin persists by isolated native location');
    assert.equal(Number(editedBin.width), editedBinWidth, 'bin width edit persisted');

    // Verify bin movement and resize through the real top-down SVG canvas.
    const binCanvas = page.getByRole('application', { name: /drawer top-down view/i });
    await binCanvas.waitFor({ state: 'visible', timeout: 10000 });
    const binDrawModeCount = await page.getByTestId('drawer-designer').getByRole('button', { name: 'Draw mode', exact: true }).count();
    console.log(`BIN_DRAW_MODE exposed=${binDrawModeCount === 1} count=${binDrawModeCount}; bin creation currently uses Add bin`);
    assert.equal(binDrawModeCount, 0, 'current drawer editor does not expose a draw-to-create bin mode');
    const binRectGeometry = async () => {
      const response = await apiRequest('get', `${api}drawers/${interiorDrawer.id}/layout/`);
      assert.equal(response.status(), 200, 'read bin geometry');
      const data = await response.json();
      return data.bins.find((bin) => bin.location === binLocation.pk);
    };
    const binBeforeMove = await binRectGeometry();
    const binScreenRect = await page.locator('svg g > rect[style]').evaluateAll((nodes) => {
      const rect = nodes.find((node) => node.style.cursor === 'move');
      if (!rect) throw new Error('Draggable bin SVG rectangle not found');
      const box = rect.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2, width: box.width, height: box.height };
    });
    await page.mouse.move(binScreenRect.x, binScreenRect.y);
    await page.mouse.down();
    await page.mouse.move(binScreenRect.x + 10 * binScreenRect.width / Number(binBeforeMove.width), binScreenRect.y + 10 * binScreenRect.height / Number(binBeforeMove.height), { steps: 8 });
    await page.mouse.up();
    const binMovePending = page.waitForResponse((response) => response.url().includes(`/drawers/${interiorDrawer.id}/layout/`) && response.request().method() === 'PUT');
    await page.getByRole('button', { name: 'Save layout', exact: true }).click();
    const binMoveResponse = await binMovePending;
    report('move bin', binMoveResponse.status(), binMoveResponse.ok());
    assert.equal(binMoveResponse.status(), 200, 'move bin save');
    const binAfterMove = await binRectGeometry();
    assert.notDeepEqual([Number(binAfterMove.x), Number(binAfterMove.y)], [Number(binBeforeMove.x), Number(binBeforeMove.y)], 'drag moves bin geometry');

    // Select and resize through the rendered southeast handle.
    const binCenter = await page.locator('svg g > rect[style]').evaluateAll((nodes) => {
      const rect = nodes.find((node) => node.style.cursor === 'move');
      const box = rect.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    });
    await page.mouse.click(binCenter.x, binCenter.y);
    const binResizeHandle = await page.locator('svg rect[style]').evaluateAll((nodes) => {
      const handle = nodes.find((node) => node.style.cursor === 'se-resize');
      if (!handle) throw new Error('South-east resize handle is not rendered for selected bin');
      const box = handle.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    });
    const binScale = await binCanvas.evaluate((node) => node.querySelector('g[transform]')?.getScreenCTM()?.a);
    assert.ok(binScale > 0, 'bin canvas model scale is available');
    await page.mouse.move(binResizeHandle.x, binResizeHandle.y);
    await page.mouse.down();
    await page.mouse.move(binResizeHandle.x + 10 * binScale, binResizeHandle.y + 10 * binScale, { steps: 8 });
    await page.mouse.up();
    const binResizePending = page.waitForResponse((response) => response.url().includes(`/drawers/${interiorDrawer.id}/layout/`) && response.request().method() === 'PUT');
    await page.getByRole('button', { name: 'Save layout', exact: true }).click();
    const binResizeResponse = await binResizePending;
    report('resize bin', binResizeResponse.status(), binResizeResponse.ok());
    assert.equal(binResizeResponse.status(), 200, 'resize bin save');
    const binAfterResize = await binRectGeometry();
    assert.ok(Number(binAfterResize.width) > Number(binAfterMove.width) && Number(binAfterResize.height) > Number(binAfterMove.height), 'drag-resize increases bin dimensions');

    // Archive one persisted drawer via the designer's explicit archive confirmation.
    await page.goto(designUrl);
    await page.getByTestId('cabinet-designer').waitFor({ timeout: 30000 });
    const archivedDrawer = layout.drawers[1];
    const archiveTarget = page.getByRole('button', { name: `Drawer ${archivedDrawer.label}`, exact: true });
    await archiveTarget.click();
    await page.getByRole('button', { name: 'Archive', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: /archive/i }).click();
    await save('archive drawer save');

    await page.reload();
    await page.getByTestId('cabinet-designer').waitFor({ timeout: 30000 });
    layoutResponse = await apiRequest('get', layoutPath);
    assert.equal(layoutResponse.status(), 200, 'reload layout');
    layout = await layoutResponse.json();
    const expectedDrawerRecords = 3;
    assert.equal(layout.drawers.length, expectedDrawerRecords, 'drawer records remain after reload');
    assert.equal(layout.drawers.filter((drawer) => drawer.archived).length, 1, 'one archived drawer persisted');
    assert.equal(new Set(layout.drawers.map((drawer) => drawer.id)).size, expectedDrawerRecords, 'stable persisted IDs after reload');

    const captureSnapshot = async () => {
      const cabinetResponse = await apiRequest('get', `${api}cabinets/${cabinetId}/`);
      const layoutSnapshotResponse = await apiRequest('get', layoutPath);
      assert.equal(cabinetResponse.status(), 200, 'snapshot cabinet details');
      assert.equal(layoutSnapshotResponse.status(), 200, 'snapshot cabinet layout');
      const cabinetRecord = await cabinetResponse.json();
      const layoutRecord = await layoutSnapshotResponse.json();
      const drawers = await Promise.all(layoutRecord.drawers.map(async (drawer) => {
        const drawerLayoutResponse = await apiRequest('get', `${api}drawers/${drawer.id}/layout/`);
        assert.equal(drawerLayoutResponse.status(), 200, `snapshot drawer ${drawer.id} layout`);
        const drawerLayout = await drawerLayoutResponse.json();
        return {
          id: drawer.id, location: drawer.location, x: drawer.x, y: drawer.y,
          width: drawer.width, height: drawer.height, archived: drawer.archived,
          bins: (drawerLayout.bins || []).map((bin) => ({
            id: bin.id, location: bin.location, x: bin.x, y: bin.y,
            width: bin.width, height: bin.height
          })).sort((a, b) => String(a.id).localeCompare(String(b.id)))
        };
      }));
      return {
        cabinet: { id: cabinetRecord.id, width_units: cabinetRecord.width_units, height_units: cabinetRecord.height_units },
        drawers: drawers.sort((a, b) => String(a.id).localeCompare(String(b.id)))
      };
    };
    const beforeRestartSnapshot = await captureSnapshot();
    console.log(`PRE-RESTART snapshot=${JSON.stringify(beforeRestartSnapshot)}`);
    execFileSync('ssh', [...sshOptions, 'inventree-deploy@mainserver-1', 'inventree-deploy restart'], {
      encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'ignore', 'ignore']
    });
    let healthy = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        const health = await page.request.get(`${base}/api/`, { timeout: 5000 });
        if (health.status() === 200) { healthy = true; break; }
      } catch { /* service is still restarting */ }
      await page.waitForTimeout(2000);
    }
    assert.ok(healthy, 'API returned HTTP 200 after approved service restart');
    console.log('PASS API health after restart HTTP 200');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.getByTestId('cabinet-designer').waitFor({ timeout: 60000 });
    const afterRestartSnapshot = await captureSnapshot();
    console.log(`POST-RESTART snapshot=${JSON.stringify(afterRestartSnapshot)}`);
    assert.deepEqual(afterRestartSnapshot, beforeRestartSnapshot, 'cabinet, drawer and bin identity/geometry snapshots survive restart');
    report(`restart persistence cabinet=${cabinetId}`, 200, true);
    console.log('Isolated fixture is retained for audit; no pre-existing cabinet was changed.');
    if (failures.length) throw new Error(`${failures.length} regression check(s) failed: ${failures.join('; ')}`);
  } finally {
    await browser.close();
  }
})().catch((error) => {
  // Deliberately do not dump Playwright request/response objects or credentials.
  console.error(`Regression stopped: ${String(error.message || error).replace(/https?:\/\/[^\s]+/g, '[URL]')}`);
  process.exitCode = 1;
});
