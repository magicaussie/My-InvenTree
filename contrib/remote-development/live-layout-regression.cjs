#!/usr/bin/env node
/* Isolated Development-only cabinet layout regression. Never logs credentials or request bodies. */
const { chromium } = require('../../src/frontend/node_modules/@playwright/test');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const base = process.env.SL_BASE_URL || 'http://192.168.1.108:18081';
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
    const context = await browser.newContext();
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
        }
        const visibleError = await page.getByRole('alert').innerText().catch(() => '');
        console.log(`UI error text: ${visibleError.replaceAll(password, '[REDACTED]').slice(0, 500)}`);
      }
      assert.equal(response.status(), 200, label);
      await page.getByText('Saved', { exact: true }).waitFor({ timeout: 15000 });
    };

    await page.getByRole('button', { name: 'Add drawer', exact: true }).click();
    // Drawer labels are SVG <text> nodes, not regular DOM text. The Add action
    // selects the new drawer; duplication is enabled from that selection.
    const drawerInspector = page.getByTestId('drawer-inspector');
    await drawerInspector.waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: 'Duplicate selection', exact: true }).click();
    await page.getByTestId('entity-count').filter({ hasText: '2 items' }).waitFor({ timeout: 10000 });
    await save('add + duplicate save');

    const layoutPath = `${api}cabinets/${cabinetId}/layout/`;
    let layoutResponse = await apiRequest('get', layoutPath);
    assert.equal(layoutResponse.status(), 200, 'read saved layout');
    let layout = await layoutResponse.json();
    assert.equal(layout.drawers.length, 2, 'both drawers persisted');
    const drawerIds = layout.drawers.map((drawer) => drawer.id);
    assert.ok(drawerIds.every((id) => id), 'persisted drawer IDs returned');

    // Change drawer geometry through the visible inspector when a drawer is selected.
    const widthField = page.getByLabel('Width', { exact: true });
    if (await widthField.count()) {
      const prior = Number(await widthField.inputValue());
      await widthField.fill(String(prior - 1));
      await widthField.press('Tab');
      await save('edit drawer save');
    } else {
      throw new Error('Drawer width inspector control was not found; edit regression not run');
    }

    // Archive one persisted drawer via the designer's explicit archive confirmation.
    const archivedDrawer = layout.drawers[1];
    const archiveTarget = page.getByText(archivedDrawer.label, { exact: true });
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
    assert.equal(layout.drawers.length, 2, 'drawer records remain after reload');
    assert.equal(layout.drawers.filter((drawer) => drawer.archived).length, 1, 'one archived drawer persisted');
    assert.equal(new Set(layout.drawers.map((drawer) => drawer.id)).size, 2, 'stable persisted IDs after reload');
    report(`reload persistence cabinet=${cabinetId}`, layoutResponse.status(), true);
    console.log('Isolated fixture is retained for audit; no pre-existing cabinet was changed.');
  } finally {
    await browser.close();
  }
})().catch((error) => {
  // Deliberately do not dump Playwright request/response objects or credentials.
  console.error(`Regression stopped: ${String(error.message || error).replace(/https?:\/\/[^\s]+/g, '[URL]')}`);
  process.exitCode = 1;
});
