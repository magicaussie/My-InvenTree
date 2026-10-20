#!/usr/bin/env node
/* Read-only authenticated Development workspace acceptance; no fixture writes. */
const { chromium, expect } = require('../../src/frontend/node_modules/@playwright/test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const base = 'http://192.168.1.108:18081';
const api = '/plugin/storage-layout/api/v1/';
const app = 'f099aa1d315a20807a88b3c62dc70c8ee4095b5b';
const ids = ['03551d5b-baf0-40e6-8028-6252d56397ce', 'd2959dce-94cc-4d03-8edc-00daa08accad', 'aacce1b1-c5b3-4e75-be5c-f1590937f863'];
const output = `docs/storage-layout/evidence/workspace-${crypto.randomUUID()}`;
let browser, secret = '';
const report = { app, base, checks: [], screenshots: [], measurements: [], blocked: [] };
const write = () => fs.writeFileSync(`${output}/report.json`, JSON.stringify(report, null, 2));
async function main() {
  assert.equal(process.env.SL_WORKSPACE_APPROVED, '1');
  fs.mkdirSync(output, { recursive: true });
  const prior = JSON.parse(fs.readFileSync('docs/storage-layout/evidence/background-635ffee0-94fb-452c-91dd-8ed171f0560c/report.json'));
  secret = execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', 'spetchal@mainserver-1', "sudo -n python3 -c \"from pathlib import Path; v=dict(line.split('=',1) for line in Path('/etc/myinventree-dev/runtime.env').read_text().splitlines()); print(v['SL_ADMIN_PASSWORD'])\""], { encoding: 'utf8', timeout: 30000 }).trim();
  browser = await chromium.launch({ headless: true, executablePath: '/bin/chromium' });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, serviceWorkers: 'block' });
  await context.route('**/*', route => {
    const r = route.request(), u = new URL(r.url());
    const login = r.method() === 'POST' && /^\/api\/auth\/v1\/auth\/login\/?$/.test(u.pathname);
    if (u.origin !== base || /\/(arm|disarm|stop|observe|discovery|pixel-tests|locate-sessions)(\/|$)/.test(u.pathname) || (!['GET','HEAD','OPTIONS'].includes(r.method()) && !login)) {
      report.blocked.push({ path: u.pathname, method: r.method() }); return route.abort();
    }
    return route.continue();
  });
  const page = await context.newPage(); page.setDefaultTimeout(20000);
  await page.goto(base + '/web/login');
  await page.getByLabel('login-username').fill('sl_admin');
  await page.getByLabel('login-password').fill(secret);
  await page.getByRole('button', { name: 'Log In', exact: true }).click();
  await page.getByLabel('navigation-menu').waitFor({ timeout: 45000 });
  const get = async path => { const r = await context.request.get(base + path); assert.equal(r.status(), 200); return r.json(); };
  const snapshot = async () => ({
    layout: await get(`${api}cabinets/${ids[0]}/layout/`),
    electrical: await get(`${api}cabinets/${ids[0]}/electrical/`),
    bins: await Promise.all(ids.slice(1).map(id => get(`${api}drawers/${id}/layout/`))),
    backgrounds: await Promise.all(ids.map((id,i) => get(`${api}${i ? 'drawers' : 'cabinets'}/${id}/background/`))),
    stock: await get(`/api/stock/${prior.fixture.stock}/`),
    locations: await Promise.all([prior.fixture.root, ...prior.fixture.drawers.flatMap(d => [d.location, d.bin.location])].map(id => get(`/api/stock/location/${id}/`)))
  });
  report.before = await snapshot(); write();
  const pass = name => { report.checks.push(name); write(); console.log('PASS ' + name); };
  const button = name => page.getByRole('button', { name, exact: true });
  for (const [index,id] of ids.entries()) {
    await page.setViewportSize({ width: 1600, height: 1100 });
    await page.goto(`${base}/web/plugin/storage-layout/${index ? 'drawers' : 'cabinets'}/${id}/design`);
    const svg = page.locator('svg[role=application]'); await expect(svg).toBeVisible();
    await page.waitForTimeout(500);
    const transform = () => svg.locator('g[transform]').first().getAttribute('transform');
    const initial = await transform();
    await button('Fit to view').click();
    assert.equal(await transform(), initial); pass(`${index}: initial automatic fit matches explicit fit`);
    for (const size of [{ width:1600,height:1100 }, { width:1280,height:900 }, { width:425,height:844 }]) {
      await page.setViewportSize(size); await page.waitForTimeout(300);
      await button('Fit to view').click();
      const b = await svg.boundingBox();
      report.measurements.push({ index, viewport:size, canvas:b, transform:await transform() });
      assert.ok(b.height >= 230, 'usable canvas including border allowance');
      assert.ok(b.y + b.height <= size.height + 100, 'canvas sensibly below toolbar');
      if (size.width > 425) { assert.ok(b.height > 400, 'desktop canvas expands'); assert.ok(Math.abs(b.y + b.height - size.height) < 55, 'fills remaining desktop viewport'); }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no horizontal overflow');
      const path = `${output}/${index}-${size.width}.png`;
      await page.screenshot({ path, fullPage:true });
      report.screenshots.push({ path, sha256:crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex') });
      pass(`${index}: ${size.width}x${size.height} workspace sizing and fit`);
    }
    await page.setViewportSize({ width:1600,height:1100 }); await button('Fit to view').click();
    await button('Zoom in').click(); const zoomed = await transform();
    await button('Grid').click();
    await page.setViewportSize({ width:1450,height:1000 }); await page.waitForTimeout(300);
    assert.equal(await transform(), zoomed); pass(`${index}: explicit zoom survives grid edit and responsive resize`);
    await button('Pan mode').click();
    const b = await svg.boundingBox();
    await page.mouse.move(b.x+b.width/2,b.y+b.height/2); await page.mouse.down(); await page.mouse.move(b.x+b.width/2+35,b.y+b.height/2+25,{steps:5}); await page.mouse.up();
    const panned = await transform(); assert.notEqual(panned, zoomed);
    await button('Grid').click(); await page.setViewportSize({width:1500,height:1050}); await page.waitForTimeout(300);
    assert.equal(await transform(), panned); pass(`${index}: explicit pan survives unrelated edit and resize`);
    await button('Fit to view').click(); assert.notEqual(await transform(), panned); pass(`${index}: explicit Fit restores fitted view`);
  }
  report.after = await snapshot(); assert.deepEqual(report.after, report.before); pass('exact fixture layout, backgrounds, inventory, locations, electrical and active mapping preservation');
  assert.ok(report.blocked.every(r => r.path === '/api/system-internal/observability/end'), 'only expected host telemetry blocked');
  report.result='PASS'; write(); console.log(output);
}
main().catch(e => { report.result='FAIL'; report.error=String(e.stack || e).replaceAll(secret || 'NO_SECRET','[REDACTED]'); write(); console.error(report.error); process.exitCode=1; }).finally(async () => { await browser?.close(); });
