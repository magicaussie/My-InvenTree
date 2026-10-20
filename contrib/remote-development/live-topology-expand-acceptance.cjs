#!/usr/bin/env node
/* Run only after deployment and explicit approval. Retains isolated fixtures; no cleanup
 * of shared records, inventory writes, mapping publication, or hardware operations.
 * SL_TOPOLOGY_EXPAND_APPROVED=1 SL_ACCEPTANCE_APPLICATION=<40-char deployed SHA>
 *   node contrib/remote-development/live-topology-expand-acceptance.cjs
 * The supplied SHA is an operator attestation, not independently verified deployment evidence.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { chromium, expect } = require('../../src/frontend/node_modules/@playwright/test');
const base = 'http://192.168.1.108:18081';
const api = '/plugin/storage-layout/api/v1/';
const root = path.resolve(__dirname, '../..');
const run = crypto.randomUUID();
const controllerOrigin = `http://192.0.2.1:${crypto.randomInt(1024, 65536)}`;
const output = path.join(root, 'docs/storage-layout/evidence', `topology-expand-${run}`);
const report = { run, base, application: process.env.SL_ACCEPTANCE_APPLICATION,
  applicationVerification: 'operator-supplied SHA; not independently verified',
  result: 'NOT_RUN', checks: [], gaps: [], screenshots: [], http: [], blocked: [], fixture: {} };
let browser, secret = '', started = false;
const redact = value => secret ? String(value).replaceAll(secret, '[REDACTED]') : String(value);
const write = () => { if (started) fs.writeFileSync(path.join(output, 'report.json'), redact(JSON.stringify(report, null, 2))); };
const pass = name => { report.checks.push(name); write(); console.log(`PASS ${name}`); };
const uuid = id => assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const hardware = /\/(?:arm|disarm|stop|observe|discovery|pixel-tests|locate-sessions|import|approve-configuration|commission|commissioning|commands|json|win)(?:\/|$)/i;
const hash = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
async function main() {
  assert.equal(process.env.SL_TOPOLOGY_EXPAND_APPROVED, '1', 'explicit approval required');
  assert.match(report.application || '', /^[0-9a-f]{40}$/i, 'SL_ACCEPTANCE_APPLICATION must be the deployed full SHA');
  fs.mkdirSync(output, { recursive: false }); started = true; report.result = 'RUNNING'; write();
  secret = execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', 'spetchal@mainserver-1',
    "sudo -n python3 -c \"from pathlib import Path; v=dict(line.split('=',1) for line in Path('/etc/myinventree-dev/runtime.env').read_text().splitlines()); print(v['SL_ADMIN_PASSWORD'])\""],
  { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  assert.ok(secret, 'runtime credential present');
  browser = await chromium.launch({ headless: true, executablePath: '/bin/chromium' });
  report.chromium = browser.version();
  const context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, serviceWorkers: 'block' });
  const allowed = new Map();
  const allow = (endpoint, methods) => allowed.set(endpoint, new Set(methods));
  await context.route('**/*', route => {
    const request = route.request(), u = new URL(request.url()), method = request.method();
    const read = ['GET', 'HEAD', 'OPTIONS'].includes(method);
    const login = method === 'POST' && /^\/api\/auth\/v1\/auth\/login\/?$/.test(u.pathname);
    if (u.origin !== base || hardware.test(u.pathname) || (!read && !login && !allowed.get(u.pathname)?.has(method))) {
      report.blocked.push({ path: u.pathname, method, foreign: u.origin !== base }); write(); return route.abort();
    }
    if (u.pathname.endsWith('/electrical/') && method === 'PUT') {
      try {
        const doc = request.postDataJSON();
        assert.equal(doc.controllers.length, 1);
        assert.equal(doc.controllers[0].enabled, false);
        assert.equal(doc.controllers[0].origin, controllerOrigin);
      } catch { report.blocked.push({ path: u.pathname, method, unsafeTopology: true }); write(); return route.abort(); }
    }
    return route.continue();
  });
  // No tracing, HAR, storageState, console capture or request bodies: credentials stay in memory.
  context.on('response', response => {
    const u = new URL(response.url());
    if (u.origin === base && u.pathname.startsWith(api)) report.http.push({ path: u.pathname, method: response.request().method(), status: response.status() });
  });
  const page = await context.newPage(); page.setDefaultTimeout(20000);
  const button = name => page.getByRole('button', { name, exact: true });
  const label = name => page.getByLabel(name, { exact: true });
  await page.goto(base + '/web/login');
  await label('login-username').fill('sl_admin'); await label('login-password').fill(secret);
  await button('Log In').click(); await page.getByLabel('navigation-menu').waitFor({ timeout: 45000 });
  const csrf = (await context.cookies()).find(c => c.name === 'csrftoken')?.value; assert.ok(csrf);
  const request = async (method, endpoint, data, extra = {}) => {
    const u = new URL(endpoint, base);
    assert.equal(u.origin, base); assert.ok(!hardware.test(u.pathname));
    if (method !== 'GET') assert.ok(allowed.get(u.pathname)?.has(method), 'API write limited to new fixtures');
    const r = await context.request.fetch(u.href, { method, maxRedirects: 0,
      headers: { 'X-CSRFToken': csrf, Referer: base + '/web/', ...extra }, ...(data === undefined ? {} : { data }) });
    report.http.push({ path: u.pathname, method, status: r.status() });
    assert.equal(r.status(), method === 'POST' ? 201 : 200, `${method} ${u.pathname}: HTTP ${r.status()}`);
    return r;
  };
  const get = async endpoint => (await request('GET', endpoint)).json();
  const shot = async name => {
    assert.ok(!page.url().includes('/login'));
    const file = path.join(output, `${name}.png`); await page.screenshot({ path: file, fullPage: true });
    report.screenshots.push({ path: path.relative(root, file), sha256: hash(fs.readFileSync(file)) }); write();
  };
  const sharedSnapshot = async () => {
    const records = []; let next = api + 'cabinets/'; const seen = new Set();
    while (next) {
      const u = new URL(next, base); assert.equal(u.origin, base); assert.equal(u.pathname, api + 'cabinets/');
      assert.ok(!seen.has(u.href), 'pagination must advance'); seen.add(u.href);
      const doc = await get(u.href); const rows = Array.isArray(doc) ? doc : doc.results;
      assert.ok(Array.isArray(rows), 'known cabinet-list shape'); records.push(...rows);
      next = Array.isArray(doc) ? null : doc.next;
    }
    return records.filter(c => c.id !== report.fixture.cabinet).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  };
  report.sharedBefore = await sharedSnapshot(); write();
  allow(api + 'cabinets/', ['POST']);
  const cabinet = await (await request('POST', api + 'cabinets/', { name: `Topology expand ${run}`, slug: `topology-expand-${run}`,
    root_location_name: `Topology expand isolated ${run}`, width_units: 600, height_units: 500 })).json();
  allowed.delete(api + 'cabinets/'); uuid(cabinet.id);
  report.fixture = { cabinet: cabinet.id, rootLocation: cabinet.location, drawers: [] }; write();
  const cp = api + `cabinets/${cabinet.id}/`, lp = cp + 'layout/', electrical = cp + 'electrical/';
  allow(lp, ['PUT']); allow(electrical, ['PUT']);
  const lr = await request('GET', lp), layout = await lr.json(); assert.equal(layout.drawers.length, 0);
  layout.drawers = [0, 1].map(i => ({ id: crypto.randomUUID(), is_new: true, label: `Acceptance drawer ${i + 1}`, display_number: i + 1,
    location: null, auto_create_location: true, x: 30 + i * 290, y: 40, width: 230, height: 180,
    interior_width: 300, interior_height: 250, archived: false, allocation: null }));
  assert.ok(lr.headers().etag); await request('PUT', lp, layout, { 'If-Match': lr.headers().etag });
  const savedLayout = await get(lp);
  assert.equal(savedLayout.drawers.length, 2);
  assert.deepEqual(savedLayout.drawers.map(d => d.id).sort(), layout.drawers.map(d => d.id).sort());
  report.fixture.drawers = savedLayout.drawers.map(d => ({ id: d.id, location: d.location })); write();
  const targets = [{ kind: 'cabinets', id: cabinet.id }, ...report.fixture.drawers.map(d => ({ kind: 'drawers', id: d.id }))];
  for (const t of targets) allow(api + `${t.kind}/${t.id}/background/`, ['POST', 'PATCH', 'DELETE']);
  const open = async t => {
    await page.goto(`${base}/web/plugin/storage-layout/${t.kind}/${t.id}/design`);
    await page.getByTestId(t.kind === 'cabinets' ? 'cabinet-designer' : 'drawer-designer').waitFor({ timeout: 45000 });
    await expect(page.locator('svg[role=application]')).toBeVisible();
    await expect(button('Upload background').or(button('Replace background'))).toBeEnabled();
  };
  await open(targets[0]);
  await page.getByRole('tab', { name: 'Topology', exact: true }).click();
  const topology = page.getByTestId('topology-editor');
  const tb = name => topology.getByRole('button', { name, exact: true });
  const tl = name => topology.getByLabel(name, { exact: true });
  await tb('Add controller').click(); await tl('Name').fill(`No-contact ${run}`);
  await tl('Origin (scheme://host:port)').fill(controllerOrigin); await expect(tl('Enabled')).not.toBeChecked();
  await tb('Add output').click(); await tl('Pixel count').fill('24'); await tl('Pins').fill('16');
  await tb('Add string').click(); await tl('Label').fill('Acceptance string'); await tl('Pixels').fill('24');
  const uiSave = async (name, endpoint, method) => {
    const response = page.waitForResponse(r => r.url() === base + endpoint && r.request().method() === method);
    await button(name).click(); const r = await response; assert.equal(r.status(), 200, `${name}: HTTP ${r.status()} ${r.status() === 200 ? '' : await r.text()}`);
    return r.json();
  };
  const identities = doc => {
    assert.equal(doc.controllers.length, 1); const c = doc.controllers[0];
    assert.equal(c.enabled, false); assert.equal(c.origin, controllerOrigin); assert.equal(c.outputs.length, 1);
    const o = c.outputs[0]; assert.equal(o.strings.length, 1); const s = o.strings[0];
    assert.equal(o.pixel_count, 24); assert.equal(s.pixel_count, 24);
    const ids = [c.id, o.id, s.id]; ids.forEach(uuid); assert.equal(new Set(ids).size, 3); return ids;
  };
  const firstSubmission = page.waitForRequest(r => r.url() === base + electrical && r.method() === 'PUT');
  const firstResponse = await uiSave('Save topology', electrical, 'PUT');
  const submitted = (await firstSubmission).postDataJSON();
  assert.equal(submitted.controllers.length, 1);
  const submittedController = submitted.controllers[0];
  assert.equal(submittedController.outputs.length, 1);
  assert.equal(submittedController.outputs[0].strings.length, 1);
  assert.deepEqual([submittedController.id, submittedController.outputs[0].id,
    submittedController.outputs[0].strings[0].id], [null, null, null], 'new UI topology submits null IDs for server assignment');
  const ids = identities(await get(electrical)); assert.deepEqual(identities(firstResponse), ids);
  report.topologyIds = ids; write();
  await tl('Label').fill('Acceptance string second save');
  identities(await uiSave('Save topology', electrical, 'PUT')).forEach((id, i) => assert.equal(id, ids[i]));
  assert.deepEqual(identities(await get(electrical)), ids);
  await page.reload(); await page.getByRole('tab', { name: 'Topology', exact: true }).click(); await expect(tl('Label')).toHaveValue('Acceptance string second save');
  await expect(tl('Enabled')).not.toBeChecked(); assert.deepEqual(identities(await get(electrical)), ids);
  await shot('topology-saved'); pass('UI-created topology receives server UUIDs; second UI save and reload preserve IDs and edits');

  await page.getByRole('tab', { name: 'Drawers and Bins', exact: true }).click();
  const imageGeometry = () => page.getByTestId('background-image').evaluate(n => Object.fromEntries(['x', 'y', 'width', 'height', 'opacity'].map(k => [k, n.getAttribute(k)])));
  const png = async variant => Buffer.from(await page.evaluate(v => {
    const c = document.createElement('canvas'); c.width = 320; c.height = 240; const x = c.getContext('2d');
    x.fillStyle = v ? '#d8b890' : '#90b8d8'; x.fillRect(0, 0, 320, 240); x.fillStyle = '#223344';
    x.font = '22px sans-serif'; x.fillText(v ? 'REPLACEMENT' : 'ISOLATED ACCEPTANCE', 12, 70); x.strokeRect(20, 100, 270, 110);
    return c.toDataURL('image/png').split(',')[1];
  }, variant), 'base64');
  const upload = async (endpoint, buffer) => {
    const pending = page.waitForResponse(r => r.url() === base + endpoint && r.request().method() === 'POST');
    await page.locator('input[type=file]').setInputFiles({ name: 'acceptance.png', mimeType: 'image/png', buffer });
    assert.equal((await pending).status(), 200); await expect(page.getByTestId('background-image')).toBeVisible();
    const served = await (await request('GET', endpoint + 'content/')).body();
    assert.ok(served.length > 0, 'stored image content is available after server sanitization');
  };
  for (const [index, t] of targets.entries()) {
    await open(t); const bg = api + `${t.kind}/${t.id}/background/`;
    const layoutPath = api + `${t.kind}/${t.id}/layout/`;
    const beforeLayout = await get(layoutPath);
    await upload(bg, await png(0)); await label('Edit background image').check(); await label('Lock background').uncheck();
    await label('Background width (canvas fraction)').fill('0.6');
    await label('Background x (canvas fraction)').fill('0.13'); await label('Background y (canvas fraction)').fill('0.17');
    await label('Background opacity').fill('0.65');
    await uiSave('Save background', bg, 'PATCH'); const stored = await get(bg); const geometry = await imageGeometry();
    assert.equal(stored.metadata.x, 0.13); assert.equal(stored.metadata.y, 0.17);
    assert.equal(stored.metadata.width, 0.6); assert.equal(stored.metadata.opacity, 0.65);
    await page.reload(); await expect(page.getByTestId('background-image')).toBeVisible();
    assert.deepEqual(await imageGeometry(), geometry); assert.deepEqual(await get(bg), stored);
    await label('Edit background image').check(); await label('Background opacity').fill('0.43');
    await expect(page.getByText('Unsaved background changes', { exact: true })).toBeVisible();
    // Cabinet also carries a real unsaved layout edit; drawers have unsaved image
    // metadata plus local toolbar state. Keep all nodes alive across each transition.
    if (index === 0) {
      await label('Edit background image').uncheck();
      const object = page.locator('svg[role=application] rect[style*="move"]').first();
      const box = await object.boundingBox(); assert.ok(box);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 15, box.y + box.height / 2 + 12, { steps: 6 }); await page.mouse.up();
      await expect(button('Undo')).toBeEnabled();
    }
    await button('Zoom in').click();
    const svg = page.locator('svg[role=application]');
    const handle = await svg.elementHandle(); assert.ok(handle);
    await svg.evaluate(n => { window.__acceptanceCanvas = n; });
    const initialMarkup = await svg.locator('rect[style*="move"]').evaluateAll(nodes => nodes.map(n => ['x', 'y', 'width', 'height'].map(k => n.getAttribute(k))));
    const transform = await svg.locator('g[transform]').first().getAttribute('transform');
    const overflow = await page.evaluate(() => document.body.style.overflow);
    const stateIntact = async () => {
      assert.ok(await svg.evaluate(n => n === window.__acceptanceCanvas), 'same canvas DOM node (no remount)');
      assert.ok(await handle.evaluate(n => n.isConnected));
      assert.equal(await page.getByTestId('background-image').getAttribute('opacity'), '0.43');
      await expect(page.getByText('Unsaved background changes', { exact: true })).toBeVisible();
      assert.deepEqual(await svg.locator('rect[style*="move"]').evaluateAll(nodes => nodes.map(n => ['x', 'y', 'width', 'height'].map(k => n.getAttribute(k)))), initialMarkup);
      assert.equal(await svg.locator('g[transform]').first().getAttribute('transform'), transform);
      if (index === 0) await expect(button('Undo')).toBeEnabled();
    };
    for (const mode of ['unavailable', 'denied', 'native']) {
      // Override only the actual workspace instance, never fake fullscreen state.
      await button('Expand canvas').evaluate((b, m) => {
        const w = b.closest('.mantine-Stack-root'); if (!w) throw new Error('workspace missing');
        delete w.requestFullscreen;
        if (m === 'unavailable') Object.defineProperty(w, 'requestFullscreen', { configurable: true, value: undefined });
        if (m === 'denied') Object.defineProperty(w, 'requestFullscreen', { configurable: true, value: () => Promise.reject(new DOMException('Acceptance denied', 'NotAllowedError')) });
      }, mode);
      for (const exit of ['button', 'Escape']) {
        await button('Expand canvas').click(); await expect(button('Exit full viewport')).toBeVisible();
        const native = await page.evaluate(() => !!document.fullscreenElement);
        if (mode === 'native' && !native) report.gaps.push(`${t.kind}/${t.id}: native fullscreen unavailable/denied (${exit}); real fallback tested instead`);
        if (mode !== 'native') assert.equal(native, false, 'forced fallback is not native fullscreen');
        const bounds = await svg.boundingBox(); assert.ok(bounds && bounds.height > 500, 'expanded canvas usable');
        await stateIntact(); await shot(`${index}-${mode}-${exit}`);
        if (exit === 'button') await button('Exit full viewport').click();
        else {
          await page.locator('svg[role=application]').focus();
          await page.keyboard.press('Escape');
          if (!native && await button('Exit full viewport').isVisible()) {
            await page.waitForTimeout(300);
            await page.keyboard.press('Escape');
          }
          if (native && await page.evaluate(() => !!document.fullscreenElement)) {
            report.gaps.push(`${t.kind}/${t.id}: headless native Escape not delivered by browser; explicit API exit used`);
            await page.evaluate(() => document.exitFullscreen());
          }
        }
        await expect(button('Expand canvas')).toHaveAttribute('aria-pressed', 'false');
        assert.equal(await page.evaluate(() => !!document.fullscreenElement), false);
        assert.equal(await page.evaluate(() => document.body.style.overflow), overflow);
        await stateIntact(); pass(`${t.kind} ${index}: ${mode}/${exit}, actual ${native ? 'native' : 'fallback'}, no remount or unsaved-state loss`);
      }
    }
    await button('Expand canvas').evaluate(b => { delete b.closest('.mantine-Stack-root').requestFullscreen; });
    // Save the still-unsaved image transform, proving expansion did not discard it.
    if (index === 0) {
      await uiSave('Save layout', lp, 'PUT');
      assert.notDeepEqual((await get(lp)).drawers, beforeLayout.drawers, 'actual unsaved drawer move survived expansion');
    } else assert.deepEqual(await get(layoutPath), beforeLayout, 'background-only drawer test leaves layout untouched');
    await label('Edit background image').check();
    await uiSave('Save background', bg, 'PATCH'); assert.equal((await get(bg)).metadata.opacity, 0.43);
    await handle.dispose();
    await page.reload(); await expect(page.getByTestId('background-image')).toHaveAttribute('opacity', '0.43');
    await upload(bg, await png(1)); await shot(`${index}-replacement`);
    page.once('dialog', dialog => dialog.accept());
    await uiSave('Remove background', bg, 'DELETE');
    await expect(page.getByTestId('background-image')).toHaveCount(0); assert.equal((await get(bg)).image_url, null);
    await page.reload(); await expect(button('Upload background')).toBeEnabled();
    await expect(page.getByTestId('background-image')).toHaveCount(0);
    pass(`${t.kind} ${index}: actual PNG upload, transform save/reload, replacement content available, removal/reload`);
  }
  assert.deepEqual(identities(await get(electrical)), ids);
  report.sharedAfter = await sharedSnapshot();
  assert.deepEqual(report.sharedAfter, report.sharedBefore, 'existing cabinet-list records unchanged (not a full shared database audit)');
  pass('read-only shared cabinet-list snapshot preserved; write allowlist limited to newly created fixtures');
  const unexpected = report.blocked.filter(r => r.path !== '/api/system-internal/observability/end');
  assert.deepEqual(unexpected, [], 'no attempted foreign, hardware or unapproved writes');
  report.result = report.gaps.length ? 'PASS_WITH_GAPS' : 'PASS'; write(); console.log(path.relative(root, output));
}
main().catch(error => {
  report.result = 'FAIL';
  // SSH failures can carry captured stdout/stderr in Error properties: never serialize them.
  report.error = redact(error.message || 'Acceptance failed'); write(); console.error(report.error); process.exitCode = 1;
}).finally(async () => { await browser?.close(); secret = ''; });
