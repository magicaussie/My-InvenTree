#!/usr/bin/env node
/* Authenticated, read-only owner-cabinet audit plus isolated Development fixtures. */
const { chromium } = require('../../src/frontend/node_modules/@playwright/test');
const { execFileSync } = require('node:child_process');

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const base = process.env.SL_BASE_URL || 'http://192.168.1.108:18081';
const api = '/plugin/storage-layout/api/v1/';

const ownerId = 'd2e2fcc3-6946-42e7-9ae3-b80b6c914d0b';
const outDir = process.env.SL_AUDIT_DIR || `/tmp/storage-layout-audit-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const log = (label, detail) => console.log(`${label} ${JSON.stringify(detail)}`);

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  // Match the owner-approved live-layout-regression.cjs retrieval path exactly.
  // The secret remains in process memory and is never printed or persisted.
  const password = execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', 'spetchal@mainserver-1', "sudo -n python3 -c \"from pathlib import Path; v=dict(line.split('=',1) for line in Path('/etc/myinventree-dev/runtime.env').read_text().splitlines()); print(v['SL_ADMIN_PASSWORD'])\""], { encoding: 'utf8', timeout: 30000 }).trim();
  assert.ok(password, 'credential retrieval returned an empty value');
  const browser = await chromium.launch({ headless: true, ...(process.env.SL_CHROMIUM_PATH ? { executablePath: process.env.SL_CHROMIUM_PATH } : {}) });
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
    const page = await context.newPage();
    page.on('pageerror', (error) => log('PAGE_ERROR', { message: error.message }));
    page.on('response', (response) => {
      if (response.url().includes('/plugin/storage-layout/api/v1/') && response.request().method() === 'GET') {
        log('BROWSER_API', { path: new URL(response.url()).pathname, status: response.status() });
      }
    });
    await page.goto(`${base}/web/login`);
    await page.getByLabel('login-username').fill('sl_admin');
    await page.getByLabel('login-password').fill(password);
    await page.getByRole('button', { name: 'Log In', exact: true }).click();
    await page.getByLabel('navigation-menu').waitFor({ timeout: 45000 });
    const csrf = (await context.cookies()).find((cookie) => cookie.name === 'csrftoken')?.value;
    assert.ok(csrf, 'authenticated CSRF cookie unavailable');
    const headers = { 'X-CSRFToken': csrf, Referer: `${base}/web/` };
    const request = async (method, url, data) => {
      const response = await context.request[method](base + url, {
        headers, ...(data === undefined ? {} : { data })
      });
      const body = response.ok() ? await response.json().catch(() => null) : null;
      const safeBody = body && Array.isArray(body.results)
        ? { count: body.count ?? body.results.length, results: body.results.map(({ id, name, slug }) => ({ id, name, slug })) }
        : body && Array.isArray(body.drawers)
          ? { revision: body.revision ?? null, loading: body.loading ?? null, drawerCount: body.drawers.length, drawers: body.drawers.map(({ id, label, location, archived, x, y, width, height }) => ({ id, label, location, archived, x, y, width, height })) }
          : body && typeof body === 'object'
            ? Object.fromEntries(['id', 'pk', 'name', 'width_units', 'height_units', 'location', 'structural'].filter((key) => body[key] !== undefined).map((key) => [key, body[key]]))
            : null;
      log('API', { method: method.toUpperCase(), path: url, status: response.status(), ...(safeBody ? { body: safeBody } : {}) });
      return { response, body };
    };
    console.log('PASS authenticated browser login; Development only; no restart/deploy/hardware actions');

    const list = await request('get', `${api}cabinets/`);
    assert.equal(list.response.status(), 200);
    let all = list.body.results || list.body;
    let next = list.body.next;
    while (next) {
      const url = new URL(next, base);
      const pageResult = await request('get', url.pathname + url.search);
      assert.equal(pageResult.response.status(), 200);
      all = all.concat(pageResult.body.results || pageResult.body);
      next = pageResult.body.next;
    }
    const cabinet = all.find((item) => item.id === ownerId) || all.find((item) => item.name === 'DEVELOPMENT 002J-L persistence');
    log('CABINET_LOOKUP', { requestedId: ownerId, found: Boolean(cabinet), matchedBy: cabinet ? (cabinet.id === ownerId ? 'id' : 'candidate name DEVELOPMENT 002J-L persistence; read-only') : null, match: cabinet ? { id: cabinet.id, name: cabinet.name } : null,
      candidates: all.map(({ id, name }) => ({ id, name })) });

    if (cabinet) {
      const layout = await request('get', `${api}cabinets/${cabinet.id}/layout/`);
      const ownerUrl = `${base}/web/plugin/storage-layout/cabinets/${cabinet.id}/design`;
      await page.goto(ownerUrl);
      await page.getByTestId('cabinet-designer').waitFor({ timeout: 30000 });
      await page.waitForTimeout(1200);
      const rendered = await page.evaluate(() => ({
        title: document.title,
        text: document.querySelector('[data-testid="cabinet-designer"]')?.innerText?.slice(0, 5000),
        loading: /loading/i.test(document.querySelector('[data-testid="cabinet-designer"]')?.innerText || ''),
        emptyIndicators: [...document.querySelectorAll('body *')].filter((el) => el.children.length === 0 && /no drawers|empty|add drawer/i.test(el.textContent || '')).map((el) => el.textContent.trim()).slice(0, 20),
        controls: [...document.querySelectorAll('button')].map((el) => ({ label: el.getAttribute('aria-label') || el.innerText.trim(), disabled: el.disabled })).slice(0, 100)
      }));
      log('OWNER_RENDER', { cabinet: { id: cabinet.id, name: cabinet.name }, apiStatus: layout.response.status(),
        drawerCount: layout.body?.drawers?.length ?? null, apiLoading: layout.body?.loading ?? null, rendered });
      await page.screenshot({ path: path.join(outDir, 'owner-read-only.png'), fullPage: true });
    } else {
      console.log('BLOCKER: specified owner ID is not present in the cabinets API list; no owner cabinet was modified.');
    }

    // Dedicated fixture namespace and fresh native structural Location: never bind to or edit an existing cabinet.
    const fixtureName = `SL audit fixture ${new Date().toISOString()} ${crypto.randomUUID().slice(0, 8)}`;
    const locationResult = await request('post', '/api/stock/location/', {
      name: fixtureName, description: 'Isolated disposable parent created by live layout audit', structural: true
    });
    assert.equal(locationResult.response.status(), 201, 'create isolated fixture location');
    const fixtureResult = await request('post', `${api}cabinets/`, {
      name: fixtureName, slug: `sl-audit-${crypto.randomUUID()}`, location: locationResult.body.pk,
      width_units: 640, height_units: 840
    });
    assert.equal(fixtureResult.response.status(), 201, 'create isolated fixture cabinet');
    const fixture = fixtureResult.body;
    log('FIXTURE', { id: fixture.id, name: fixture.name, retained: true });
    await page.goto(`${base}/web/plugin/storage-layout/cabinets/${fixture.id}/design`);
    await page.getByTestId('cabinet-designer').waitFor({ timeout: 30000 });
    await page.waitForTimeout(1500);
    const fixtureText = await page.getByTestId('cabinet-designer').innerText();
    log('FIXTURE_INITIAL_RENDER', { text: fixtureText.slice(0, 2000), buttons: await page.getByRole('button').allTextContents() });
    await page.screenshot({ path: path.join(outDir, 'fixture-initial.png'), fullPage: true });
    const fixtureLayout = await request('get', `${api}cabinets/${fixture.id}/layout/`);
    log('EMPTY_VS_LOADING', { emptyLayoutHttp: fixtureLayout.response.status(), drawerCount: fixtureLayout.body?.drawers?.length ?? null, loadingField: fixtureLayout.body?.loading ?? null, conclusion: fixtureLayout.response.status() === 200 && fixtureLayout.body?.drawers?.length === 0 ? 'API returned a successfully loaded empty layout (not a loading state); no loading flag present.' : 'Inspect response evidence above.' });
    const fixtureDetail = await request('get', `${api}cabinets/${fixture.id}/`);
    const drawerIds = [];
    for (let index = 0; index < 3; index += 1) {
      const childName = `SL audit drawer ${crypto.randomUUID().slice(0, 8)}`;
      const child = await request('post', '/api/stock/location/', { name: childName, description: 'Isolated audit drawer location', parent: fixtureDetail.body.location, structural: true });
      assert.equal(child.response.status(), 201);
      await page.getByRole('button', { name: 'Add drawer', exact: true }).click();
      const inspector = page.getByTestId('drawer-inspector');
      await inspector.waitFor({ timeout: 10000 });
      await inspector.getByLabel('Location ID', { exact: true }).fill(String(child.body.pk));
      await inspector.getByLabel('X', { exact: true }).fill(String(30 + index * 180));
      await inspector.getByLabel('Y', { exact: true }).fill(String(30 + index * 100));
      await inspector.getByLabel('Location ID', { exact: true }).press('Tab');
      drawerIds.push({ location: child.body.pk });
    }
    const savePending = page.waitForResponse((response) => response.url().includes(`/cabinets/${fixture.id}/layout/`) && response.request().method() === 'PUT');
    await page.getByRole('button', { name: 'Save layout', exact: true }).click();
    const saveResult = await savePending;
    log('FIXTURE_DRAWERS_SAVE', { status: saveResult.status() });
    assert.equal(saveResult.status(), 200);
    const savedLayout = await request('get', `${api}cabinets/${fixture.id}/layout/`);
    assert.equal(savedLayout.body.drawers.length, 3);
    const rects = await page.locator('svg g > rect[style]').evaluateAll((nodes) => nodes.filter((node) => node.style.cursor === 'move').map((node) => { const box = node.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; }));
    assert.equal(rects.length, 3, 'three draggable drawers rendered');
    const drawerRows = page.getByTestId('drawer-list').locator('[aria-label^="Drawer "]');
    assert.equal(await drawerRows.count(), 3, 'sidebar exposes all drawers as selectable rows');
    await drawerRows.nth(0).click();
    await drawerRows.nth(1).click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
    const selectionEvidence = await page.evaluate(() => ({
      selectedRows: [...document.querySelectorAll('[data-testid="drawer-list"] [aria-selected="true"]')].map((row) => row.getAttribute('aria-label')),
      arrangeSection: [...document.querySelectorAll('*')].find((el) => el.children.length === 0 && el.textContent.trim() === 'Arrange selection')?.parentElement?.innerText || null,
      controls: [...document.querySelectorAll('button, [role="button"]')].map((el) => ({ label: el.getAttribute('aria-label') || el.innerText.trim(), disabled: el.getAttribute('disabled') !== null })).filter((item) => /align|distribut/i.test(item.label))
    }));
    log('MULTISELECT_UI', selectionEvidence);
    await page.screenshot({ path: path.join(outDir, 'fixture-multiselect.png'), fullPage: true });
    const alignDistribute = selectionEvidence.controls;
    log('ALIGN_DISTRIBUTE_AUDIT', { availableControls: alignDistribute, selectedRows: selectionEvidence.selectedRows, arrangeSection: selectionEvidence.arrangeSection, conclusion: alignDistribute.length ? 'Controls present and enabled with two selected drawers; distribution operation will be verified with all three.' : 'Controls not exposed; inspect selectedRows and arrangeSection to distinguish failed selection from absent controls.' });
    assert.equal(selectionEvidence.selectedRows.length, 2, 'Ctrl-click selects two drawer sidebar rows');
    assert.equal(alignDistribute.length, 6, 'all four align and two distribution modes are exposed');
    for (const label of ['Align left', 'Distribute horizontally']) {
      await page.getByRole('button', { name: label, exact: true }).click();
      if (label === 'Distribute horizontally') {
        await drawerRows.nth(2).click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
        assert.equal(await page.locator('[data-testid="drawer-list"] [aria-selected="true"]').count(), 3);
        await page.getByRole('button', { name: label, exact: true }).click();
      }
      const pending = page.waitForResponse((response) => response.url().includes(`/cabinets/${fixture.id}/layout/`) && response.request().method() === 'PUT');
      await page.getByRole('button', { name: 'Save layout', exact: true }).click();
      assert.equal((await pending).status(), 200, `${label} result saves`);
    }
    const arranged = await request('get', `${api}cabinets/${fixture.id}/layout/`);
    const byX = [...arranged.body.drawers].sort((a, b) => a.x - b.x);
    assert.equal(byX.length, 3);
    const gaps = [byX[1].x - byX[0].x - byX[0].width, byX[2].x - byX[1].x - byX[1].width];
    assert.ok(Math.abs(gaps[0] - gaps[1]) <= 1, 'horizontal distribution yields equal gaps within rounding tolerance');
    log('ALIGN_DISTRIBUTE_RESULT', { drawerIds: byX.map(({ id }) => id), x: byX.map(({ x }) => x), gaps, alignmentSaved: true, distributionVerified: true });
    const drawer = savedLayout.body.drawers[0];
    const binLocation = await request('post', '/api/stock/location/', { name: `SL audit bin ${crypto.randomUUID().slice(0, 8)}`, description: 'Isolated audit bin location', parent: drawer.location, structural: false });
    assert.equal(binLocation.response.status(), 201);
    await page.goto(`${base}/web/plugin/storage-layout/drawers/${drawer.id}/design`);
    await page.getByRole('button', { name: 'Add bin', exact: true }).click();
    const binInspector = page.getByTestId('bin-inspector');
    await binInspector.waitFor({ timeout: 10000 });
    await binInspector.getByLabel('Location ID', { exact: true }).fill(String(binLocation.body.pk));
    const binWidth = binInspector.getByLabel('Width', { exact: true });
    const originalBinWidth = Number(await binWidth.inputValue());
    await binWidth.fill(String(originalBinWidth - 1));
    await binWidth.press('Tab');
    const binSavePending = page.waitForResponse((response) => response.url().includes(`/drawers/${drawer.id}/layout/`) && response.request().method() === 'PUT');
    await page.getByRole('button', { name: 'Save layout', exact: true }).click();
    const binSave = await binSavePending;
    log('BIN_EDIT_SAVE', { status: binSave.status(), originalWidth: originalBinWidth, editedWidth: originalBinWidth - 1 });
    assert.equal(binSave.status(), 200);
    const persistedBins = await request('get', `${api}drawers/${drawer.id}/layout/`);
    const editedBin = persistedBins.body.bins.find((item) => item.location === binLocation.body.pk);
    log('BIN_EDIT_PERSISTENCE', { found: Boolean(editedBin), width: editedBin?.width, expectedWidth: originalBinWidth - 1 });
    assert.equal(Number(editedBin.width), originalBinWidth - 1);
    await page.screenshot({ path: path.join(outDir, 'fixture-bin-edited.png'), fullPage: true });
    console.log(`SCREENSHOTS ${outDir}`);
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(`AUDIT_STOPPED: ${String(error.message || error).replace(/https?:\/\/[^\s]+/g, '[URL]')}`);
  process.exitCode = 1;
});
