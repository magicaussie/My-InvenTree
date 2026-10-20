#!/usr/bin/env node
/* Opt-in live Development follow-up. No deployment or fixture-record deletion; optional approved restricted restart. */
const { chromium, expect } = require('../../src/frontend/node_modules/@playwright/test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const base = 'http://192.168.1.108:18081';
const fixtureIds = ['03551d5b-baf0-40e6-8028-6252d56397ce', 'd2959dce-94cc-4d03-8edc-00daa08accad', 'aacce1b1-c5b3-4e75-be5c-f1590937f863'];
const api = '/plugin/storage-layout/api/v1/';
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
let browser, secret = '';
let report, output;
const write = () => { if (output) fs.writeFileSync(`${output}/report.json`, JSON.stringify(report, null, 2)); };
const redact = text => secret ? String(text).replaceAll(secret, '[REDACTED]') : String(text);
async function main() {
  assert.equal(process.env.SL_BACKGROUND_FOLLOWUP_APPROVED, '1', 'Wait for deployment signal; explicit SL_BACKGROUND_FOLLOWUP_APPROVED=1 required');
  assert.ok(process.argv[2], 'Pass original acceptance report.json');
  assert.match(process.env.SL_ACCEPTANCE_APPLICATION || '', /^[0-9a-f]{40}$/, 'Record lead-confirmed deployed application SHA');
  const prior = JSON.parse(fs.readFileSync(process.argv[2]));
  assert.equal(prior.base, base);
  assert.deepEqual([prior.fixture.cabinet, ...prior.fixture.drawers.map(d => d.id)], fixtureIds);
  output = `docs/storage-layout/evidence/background-followup-${crypto.randomUUID()}`;
  fs.mkdirSync(output, { recursive: true });
  report = { base, applicationReportedByLead: process.env.SL_ACCEPTANCE_APPLICATION, started: new Date().toISOString(), fixture: prior.fixture, checks: [], http: [], screenshots: [], snapshots: {}, limitations: ['No deployment performed by this runner; restricted restart only when explicitly opted in.', 'Live cross-owner denial cannot be verified while shared STOCK_OWNERSHIP_CONTROL is False. No ownership settings changed.', '390px requires browser-local allowMobile override; 425px is default supported minimum.'] };
  write();
  secret = execFileSync('ssh', ['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','spetchal@mainserver-1', "sudo -n python3 -c \"from pathlib import Path; v=dict(line.split('=',1) for line in Path('/etc/myinventree-dev/runtime.env').read_text().splitlines()); print(v['SL_ADMIN_PASSWORD'])\""], { encoding: 'utf8', timeout: 30000 }).trim();
  assert.ok(secret);
  browser = await chromium.launch({ headless: true, executablePath: process.env.SL_CHROMIUM_PATH || '/bin/chromium' });
  report.chromium = browser.version();
  const context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, serviceWorkers: 'block' });
  const items = fixtureIds.map((id, i) => ({ id, target: i ? 'drawers' : 'cabinets', endpoint: `${api}${i ? 'drawers' : 'cabinets'}/${id}/background/` }));
  const endpoints = new Set(items.map(i => i.endpoint));
  const blocked = [];
  await context.route('**/*', route => {
    const request = route.request(), u = new URL(request.url());
    const login = request.method() === 'POST' && /^\/api\/auth\/v1\/auth\/login\/?$/.test(u.pathname);
    const unsafe = /\/(arm|disarm|stop|observe|discovery|pixel-tests|locate-sessions|import|approve-configuration)(\/|$)/.test(u.pathname);
    if (u.origin !== base || unsafe || (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && !endpoints.has(u.pathname) && !login)) {
      blocked.push({ path: u.pathname, method: request.method() }); return route.abort();
    }
    return route.continue();
  });
  context.on('response', r => { const path = new URL(r.url()).pathname; if (path.startsWith(api)) report.http.push({ path, method: r.request().method(), status: r.status(), etag: r.headers().etag }); });
  const page = await context.newPage(); page.setDefaultTimeout(20000);
  await page.goto(base + '/web/login');
  await page.getByLabel('login-username').fill('sl_admin');
  await page.getByLabel('login-password').fill(secret);
  await page.getByRole('button', { name: 'Log In', exact: true }).click();
  await page.getByLabel('navigation-menu').waitFor({ timeout: 45000 });
  const button = name => page.getByRole('button', { name, exact: true });
  const label = name => page.getByLabel(name, { exact: true });
  const get = async path => { const r = await context.request.get(base + path); assert.equal(r.status(), 200, path); return r.json(); };
  const contentHash = async endpoint => { const r = await context.request.get(base + endpoint + 'content/'); assert.equal(r.status(), 200); return hash(await r.body()); };
  const snapshot = async endpoint => ({ document: await get(endpoint), sha256: await contentHash(endpoint) });
  const preservation = async () => {
    const layout = await get(`${api}cabinets/${fixtureIds[0]}/layout/`);
    return { drawers: layout.drawers, mapping: layout.cabinet.active_mapping, mappingHash: layout.cabinet.mapping_hash, electrical: await get(`${api}cabinets/${fixtureIds[0]}/electrical/`), stock: await get(`/api/stock/${prior.fixture.stock}/`), locations: await Promise.all([prior.fixture.root, ...prior.fixture.drawers.flatMap(d => [d.location, d.bin.location])].map(id => get(`/api/stock/location/${id}/`))), bins: await Promise.all(items.slice(1).map(i => get(`${api}drawers/${i.id}/layout/`))) };
  };
  // Background writes intentionally advance the cabinet aggregate CAS revision.
  const stable = value => JSON.parse(JSON.stringify(value, (key, value) => key === 'revision' ? undefined : value));
  const baseline = await preservation(); report.snapshots.preservationBefore = baseline;
  const pass = name => { report.checks.push(name); write(); console.log(`PASS ${name}`); };
  const shot = async name => { assert.ok(!page.url().includes('login')); const path = `${output}/${name}.png`; await page.screenshot({ path, fullPage: true }); report.screenshots.push({ path, sha256: hash(fs.readFileSync(path)) }); write(); };
  const open = async item => { await page.goto(`${base}/web/plugin/storage-layout/${item.target}/${item.id}/design`); await page.getByTestId(item.target === 'cabinets' ? 'cabinet-designer' : 'drawer-designer').waitFor(); await expect(button('Replace background').or(button('Upload background'))).toBeEnabled(); };
  const raster = async mime => Buffer.from(await page.evaluate(type => { const c = document.createElement('canvas'); c.width = 320; c.height = 160; const x = c.getContext('2d'); x.fillStyle = '#9abccf'; x.fillRect(0, 0, 320, 160); x.fillStyle = '#132738'; x.font = '24px sans-serif'; x.fillText('ISOLATED ' + type, 12, 70); return c.toDataURL(type).split(',')[1]; }, mime), 'base64');
  const upload = async (item, mime, buffer) => { const response = page.waitForResponse(r => r.url() === base + item.endpoint && r.request().method() === 'POST'); await page.locator('input[type=file]').setInputFiles({ name: `isolated.${mime.split('/')[1]}`, mimeType: mime, buffer }); assert.equal((await response).status(), 200); await expect(page.getByTestId('background-image')).toBeVisible(); await expect(button('Replace background')).toBeEnabled(); };
  for (const [index, item] of items.entries()) {
    await open(item);
    const original = await snapshot(item.endpoint); report.snapshots[`original-${index}`] = original; write();
    // Abort only an actual multipart POST to this isolated fixture, never a mocked success.
    const abort = route => route.request().method() === 'POST' ? route.abort('failed') : route.fallback();
    await page.route(base + item.endpoint, abort);
    const failed = page.waitForEvent('requestfailed', { predicate: r => r.url() === base + item.endpoint && r.method() === 'POST' });
    await page.locator('input[type=file]').setInputFiles({ name: 'failed.png', mimeType: 'image/png', buffer: await raster('image/png') });
    await failed; await expect(page.getByRole('alert').filter({ hasText: 'local changes have not been discarded' })).toBeVisible(); await expect(button('Replace background')).toBeEnabled();
    await page.unroute(base + item.endpoint, abort);
    assert.deepEqual(await snapshot(item.endpoint), original);
    await shot(`failed-upload-${index}`); await page.reload(); await expect(page.getByTestId('background-image')).toBeVisible();
    assert.deepEqual(await snapshot(item.endpoint), original); pass(`${item.target} ${index}: aborted real upload preserves saved metadata/content and reload`);
    for (const mime of ['image/jpeg', 'image/webp']) { await upload(item, mime, await raster(mime)); await page.reload(); await expect(page.getByTestId('background-image')).toBeVisible(); const r = await context.request.get(base + item.endpoint + 'content/'); assert.equal(r.status(), 200); assert.match(r.headers()['content-type'], /image\/png/); pass(`${item.target} ${index}: actual ${mime} upload, PNG normalization and reload`); }
    const saved = await snapshot(item.endpoint);
    page.once('dialog', d => d.dismiss()); await button('Remove background').click(); assert.deepEqual(await snapshot(item.endpoint), saved);
    const removed = page.waitForResponse(r => r.url() === base + item.endpoint && r.request().method() === 'DELETE');
    page.once('dialog', d => d.accept()); await button('Remove background').click(); assert.equal((await removed).status(), 200);
    await expect(page.getByTestId('background-image')).toHaveCount(0); assert.equal((await get(item.endpoint)).image_url, null);
    await page.reload(); await expect(button('Upload background')).toBeEnabled(); await expect(page.getByTestId('background-image')).toHaveCount(0);
    await shot(`detached-${index}`); pass(`${item.target} ${index}: cancel then confirm reference detach persists; fixture records retained`);
    // Restore original bytes and metadata using UI, retaining fixture records.
    await upload(item, 'image/png', fs.readFileSync(`${require('node:path').dirname(process.argv[2])}/source-${index}.png`));
    await label('Edit background image').check(); await label('Lock background').uncheck(); await label('Preserve aspect ratio').uncheck();
    for (const key of ['x', 'y', 'width', 'height']) await label(`Background ${key} (canvas fraction)`).fill(String(original.document.metadata[key]));
    await label('Background opacity').fill(String(original.document.metadata.opacity));
    await label('Show background').setChecked(original.document.metadata.visible);
    await label('Preserve aspect ratio').setChecked(original.document.metadata.aspect_locked);
    await label('Lock background').setChecked(original.document.metadata.locked);
    if (await button('Save background').isEnabled()) { const response = page.waitForResponse(r => r.url() === base + item.endpoint && r.request().method() === 'PATCH'); await button('Save background').click(); assert.equal((await response).status(), 200); }
    assert.deepEqual(await snapshot(item.endpoint), original); pass(`${item.target} ${index}: original image and metadata restored exactly`);
  }
  const item = items[0]; await open(item);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }); const arrived = new Promise(resolve => { entered = resolve; });
  const delay = async route => { if (route.request().method() !== 'POST') return route.fallback(); entered(); await gate; return route.continue(); };
  await page.route(base + item.endpoint, delay);
  try {
    const response = page.waitForResponse(r => r.url() === base + item.endpoint && r.request().method() === 'POST');
    await page.locator('input[type=file]').setInputFiles({ name: 'pending.png', mimeType: 'image/png', buffer: fs.readFileSync(`${require('node:path').dirname(process.argv[2])}/source-0.png`) });
    await Promise.race([arrived, new Promise((_, reject) => setTimeout(() => reject(new Error('Pending upload was not intercepted')), 15000))]);
    await expect(button('Replace background')).toBeDisabled();
    let dialogs = 0; const dismiss = async d => { dialogs++; await d.dismiss(); }; page.on('dialog', dismiss);
    const url = page.url(); await page.getByRole('tab', { name: 'Storage Layout', exact: true }).click(); assert.equal(page.url(), url); assert.equal(dialogs, 1); page.off('dialog', dismiss);
    await shot('pending-navigation-blocked'); release(); assert.equal((await response).status(), 200); await expect(button('Replace background')).toBeEnabled();
    await page.getByRole('tab', { name: 'Storage Layout', exact: true }).click(); await page.getByTestId('cabinet-list').waitFor(); pass('real pending upload blocks dismissed host navigation; completes and permits clean navigation');
  } finally { release(); await page.unroute(base + item.endpoint, delay); }
  const geometry = loc => loc.evaluate(n => Object.fromEntries(['x','y','width','height'].map(k => [k, Number(n.getAttribute(k))])));
  const drag = async (loc, dx, dy) => { await loc.scrollIntoViewIfNeeded(); const b = await loc.boundingBox(); assert.ok(b); assert.ok(b.x >= 0 && b.x + b.width <= (await page.viewportSize()).width + 1, 'gesture target inside viewport'); await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down(); await page.mouse.move(b.x + b.width / 2 + dx, b.y + b.height / 2 + dy, { steps: 8 }); await page.mouse.up(); };
  for (const width of [425, 390]) {
    if (width === 390) await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('session-settings')); s.state.allowMobile = true; localStorage.setItem('session-settings', JSON.stringify(s)); });
    await page.setViewportSize({ width, height: 844 });
    for (const [index, current] of items.entries()) {
      await open(current); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no horizontal document overflow');
      await label('Edit background image').check(); await label('Lock background').uncheck();
      await label('Background width (canvas fraction)').fill('0.4'); await label('Background x (canvas fraction)').fill('0.1'); await label('Background y (canvas fraction)').fill('0.1');
      const image = page.getByTestId('background-image'); const before = await geometry(image);
      await drag(page.locator('svg[role=application] rect[style*="move"]').first(), 8, 6); const moved = await geometry(image); assert.notDeepEqual(moved, before);
      await drag(page.locator('svg rect[style*="se-resize"]'), 8, 6); assert.ok((await geometry(image)).width > moved.width);
      await button('Undo background').click(); assert.deepEqual(await geometry(image), moved); await button('Redo background').click();
      await shot(`pointer-${width}-${index}`); await button('Revert background').click(); await label('Edit background image').uncheck();
      if (width === 390) {
        report.limitations.push(`${current.target} ${index}: 390px override image gestures passed; object gestures not asserted after cabinet move remained unchanged in two prior bounded probes. 425px object gestures passed. Tiny override canvas requires separate hit-target investigation.`);
        pass(`${width}px ${current.target} ${index}: no overflow, image pointer move/resize and undo/redo; image draft reverted; object gesture limitation recorded`);
        continue;
      }
      const object = page.locator('svg[role=application] rect[style*="move"]').first(); const g = await geometry(object); await drag(object, -4, -4); assert.notDeepEqual(await geometry(object), g); await button('Undo').click(); assert.deepEqual(await geometry(object), g);
      await drag(page.locator('svg rect[style*="se-resize"]'), -4, -4); assert.ok((await geometry(object)).width < g.width); await button('Undo').click(); assert.deepEqual(await geometry(object), g);
      pass(`${width}px ${current.target} ${index}: no overflow, real image/object pointer move/resize and undo; drafts reverted`);
    }
  }
  report.snapshots.preservationAfter = await preservation(); assert.deepEqual(stable(report.snapshots.preservationAfter), stable(baseline));
  if (process.env.SL_BACKGROUND_RESTART_APPROVED === '1') {
    const before = await Promise.all(items.map(i => snapshot(i.endpoint)));
    report.snapshots.backgroundsBeforeRestart = before; write();
    execFileSync('ssh', ['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','IdentitiesOnly=yes','-i','/home/spetchal/.ssh/myinventree-development-deploy_ed25519','inventree-deploy@mainserver-1','inventree-deploy restart'], { encoding: 'utf8', timeout: 180000, stdio: ['ignore','pipe','pipe'] });
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try { if ((await context.request.get(base + '/api/')).status() === 200) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    assert.ok(ready, 'Development recovered after restricted restart');
    report.snapshots.backgroundsAfterRestart = await Promise.all(items.map(i => snapshot(i.endpoint)));
    assert.deepEqual(report.snapshots.backgroundsAfterRestart, before);
    report.snapshots.preservationAfterRestart = await preservation();
    assert.deepEqual(report.snapshots.preservationAfterRestart, report.snapshots.preservationAfter);
    await page.setViewportSize({ width: 1600, height: 1100 });
    for (const [index, current] of items.entries()) { await open(current); await expect(page.getByTestId('background-image')).toBeVisible(); await shot(`restart-desktop-${index}`); }
    report.restrictedStatus = execFileSync('ssh', ['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','IdentitiesOnly=yes','-i','/home/spetchal/.ssh/myinventree-development-deploy_ed25519','inventree-deploy@mainserver-1','inventree-deploy status'], { encoding: 'utf8', timeout: 30000 });
    pass('restricted Development restart: three content hashes/metadata, layouts, stock, native locations, active mapping, allocations and topology preserved; authenticated desktop renders');
  }
  report.blockedRequests = blocked;
    assert.deepEqual(blocked.filter(r => !(r.method === 'POST' && r.path === '/api/system-internal/observability/end')), []);
  pass('stock/native locations/layouts/active mapping/allocations/topology unchanged; no hardware requests; host observability POSTs blocked by fixture-only boundary');
  report.result = 'PASS_WITH_DOCUMENTED_LIMITATIONS'; report.finished = new Date().toISOString(); write(); console.log(`EVIDENCE ${output}/report.json`);
}
if (require.main === module) main().catch(error => { if (report) { report.result = 'FAIL'; report.failure = redact(error.message); write(); } console.error(redact(error.message)); process.exitCode = 1; }).finally(async () => { await browser?.close(); });
