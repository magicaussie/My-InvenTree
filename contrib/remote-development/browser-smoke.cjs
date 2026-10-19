/* Development-only live browser persistence check. Never traces login or logs secrets. */
const { chromium } = require('../../src/frontend/node_modules/@playwright/test');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const base = 'http://192.168.1.108:18081';
const api = '/plugin/storage-layout/api/v1/';
const sshOptions = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes'];
const remote = (command) => execFileSync('ssh', [...sshOptions, 'spetchal@mainserver-1', command], { encoding: 'utf8', timeout: 90000 });
const lifecycle = (verb) => execFileSync('ssh', [...sshOptions, '-o', 'IdentitiesOnly=yes', '-i', '/home/spetchal/.ssh/myinventree-development-deploy_ed25519', 'inventree-deploy@mainserver-1', `inventree-deploy ${verb}`], { encoding: 'utf8', timeout: 360000 });
(async () => {
  const password = remote("sudo -n python3 -c \"from pathlib import Path; v=dict(line.split('=',1) for line in Path('/etc/myinventree-dev/runtime.env').read_text().splitlines()); print(v['SL_ADMIN_PASSWORD'])\"").trim();
  const browser = await chromium.launch({ headless: true, ...(process.env.SL_CHROMIUM_PATH ? { executablePath: process.env.SL_CHROMIUM_PATH } : {}) });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${base}/web/login`);
    await page.waitForLoadState('networkidle');
    await page.getByLabel('login-username').fill('sl_admin');
    await page.getByLabel('login-password').fill(password);
    await page.getByRole('button', { name: 'Log In', exact: true }).click();
    try {
      await page.getByLabel('navigation-menu').waitFor({ timeout: 45000 });
    } catch {
      console.log('Login page status:', page.url(), (await page.locator('body').innerText()).replaceAll(password, '[REDACTED]').slice(0, 1800));
      throw new Error('Browser login did not reach authenticated navigation');
    }
    console.log('PASS authenticated browser login');
    const get = async (path) => {
      const response = await context.request.get(base + path);
      assert.equal(response.status(), 200, `GET ${path}`);
      return response.json();
    };
    const csrf = (await context.cookies()).find(c => c.name === 'csrftoken')?.value;
    const headers = { 'X-CSRFToken': csrf, Referer: base + '/web/' };
    const features = await get('/api/plugins/ui/features/navigation/');
    assert.ok(JSON.stringify(features).includes('storage-layout-nav'));
    await page.getByRole('tab', { name: 'Storage Layout', exact: true }).click();
    await page.getByTestId('cabinet-list').waitFor();
    console.log('PASS plugin discovery/navigation/list');
    const list = await get(api + 'cabinets/');
    let cabinet = list.results.find(c => c.slug === 'dev-002jl-persistence');
    if (!cabinet) {
      const locations = await get('/api/stock/location/');
      const location = (locations.results || locations).find(l => l.name === 'SL Integration Cabinet') || (locations.results || locations)[0];
      assert.ok(location, 'safe seed location exists');
      const response = await context.request.post(base + api + 'cabinets/', {
        headers, data: { name: 'DEVELOPMENT 002J-L persistence', slug: 'dev-002jl-persistence', location: location.pk, width_units: 600, height_units: 800 }
      });
      assert.equal(response.status(), 201, 'create harmless Dev cabinet');
      cabinet = await response.json();
    }
    const design = `${base}/web/plugin/storage-layout/cabinets/${cabinet.id}/design`;
    await page.goto(design);
    await page.getByTestId('cabinet-designer').waitFor({ timeout: 30000 });
    if (await page.getByRole('button', { name: 'Show cabinet properties', exact: true }).count()) await page.getByRole('button', { name: 'Show cabinet properties', exact: true }).click();
    const before = await get(api + `cabinets/${cabinet.id}/layout/`);
    const width = before.cabinet.width_units === 640 ? 660 : 640;
    const height = before.cabinet.height_units === 840 ? 860 : 840;
    await page.getByLabel('Cabinet width in units', { exact: true }).fill(String(width));
    await page.getByLabel('Cabinet height in units', { exact: true }).fill(String(height));
    await page.getByLabel('Cabinet height in units', { exact: true }).press('Tab');
    const saved = page.waitForResponse(r => r.url().includes(`/cabinets/${cabinet.id}/layout/`) && r.request().method() === 'PUT');
    await page.getByLabel('Save layout', { exact: true }).click();
    let response;
    try { response = await saved; } catch {
      console.log('Save UI:', (await page.getByTestId('cabinet-designer').innerText()).slice(0, 2000));
      throw new Error('Designer save produced no PUT response');
    }
    console.log(`Designer PUT ${api}cabinets/${cabinet.id}/layout/ HTTP ${response.status()}`);
    assert.equal(response.status(), 200, 'designer save response');
    await page.getByText('Saved', { exact: true }).waitFor();
    const verify = async (stage) => {
      await page.reload();
      try {
        await page.getByTestId('cabinet-designer').waitFor({ timeout: 45000 });
      } catch {
        console.log('Persistence page:', page.url(), (await page.locator('body').innerText()).replaceAll(password, '[REDACTED]').slice(0, 1800));
        throw new Error(`Designer unavailable during ${stage}`);
      }
      if (await page.getByRole('button', { name: 'Show cabinet properties', exact: true }).count()) await page.getByRole('button', { name: 'Show cabinet properties', exact: true }).click();
      assert.equal(await page.getByLabel('Cabinet width in units', { exact: true }).inputValue(), String(width));
      assert.equal(await page.getByLabel('Cabinet height in units', { exact: true }).inputValue(), String(height));
      const layout = await get(api + `cabinets/${cabinet.id}/layout/`);
      assert.equal(layout.cabinet.width_units, width);
      assert.equal(layout.cabinet.height_units, height);
      console.log(`PASS ${stage}: cabinet=${cabinet.id} dimensions=${width}x${height} revision=${layout.cabinet.revision}`);
    };
    await verify('save-refresh persistence');
    lifecycle('restart');
    for (let i = 0; i < 60; i++) {
      try { const r = await context.request.get(base + '/api/'); if (r.ok()) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    await verify('container-restart persistence');
    if (process.env.SL_VERIFY_RECREATE === '1') {
      remote('sudo -n docker compose --project-name myinventree-dev --file /etc/myinventree-dev/compose.yml --env-file /etc/myinventree-dev/runtime.env up -d --no-deps --force-recreate --wait --wait-timeout 180 backend proxy');
      await verify('container-replacement persistence');
    }
    console.log(lifecycle('status'));
  } finally { await browser.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
