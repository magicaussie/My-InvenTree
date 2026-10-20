import { expect, test } from '@playwright/test';
import { open, recordedCalls } from './helpers';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6HkAAAAASUVORK5CYII=', 'base64');
for (const target of ['cabinet', 'drawer'] as const) {
  test(`${target} image upload, editing isolation, CAS, reopen and removal preserve layout`, async ({ page }) => {
    const route = target === 'cabinet' ? { path: '/cabinets/cab-1/design', feature: 'RenderCabinetDesigner' } : { path: '/drawers/drawer-1/design', feature: 'RenderDrawerDesigner' };
    await open(page, route);
    await expect(page.getByRole('button', { name: 'Upload background' })).toBeEnabled();
    const before = await page.locator('svg[role=application] rect[style*="move"]').evaluateAll((elements) => elements.map((element) => ['x', 'y', 'width', 'height'].map((key) => element.getAttribute(key))));
    await page.locator('input[type=file]').setInputFiles({ name: 'reference.png', mimeType: 'image/png', buffer: png });
    await expect(page.getByTestId('background-image')).toBeVisible();
    await page.getByLabel('Edit background image', { exact: true }).check();
    await page.getByLabel('Lock background', { exact: true }).uncheck();
    await page.getByRole('button', { name: 'Fit background', exact: true }).click();
    await page.getByLabel('Background opacity', { exact: true }).fill('0.7');
    await page.getByRole('application').focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Control+d');
    await page.keyboard.press('Delete');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: 'Save background', exact: true }).click();
    await expect(page.getByText('Unsaved background changes', { exact: true })).toHaveCount(0);
    await page.getByLabel('Edit background image', { exact: true }).uncheck();
    const after = await page.locator('svg[role=application] rect[style*="move"]').evaluateAll((elements) => elements.map((element) => ['x', 'y', 'width', 'height'].map((key) => element.getAttribute(key))));
    expect(after).toEqual(before);
    const calls = await recordedCalls(page);
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(0);
    expect(calls.find((call) => call.method === 'PATCH' && call.url.includes('/background/'))?.headers?.['If-Match']).toBeTruthy();
    await page.reload();
    await expect(page.getByTestId('background-image')).toHaveAttribute('opacity', '0.7');
    // A locked underlay remains transparent to ordinary drawer/bin drawing.
    await page.getByLabel('Draw mode', { exact: true }).click();
    const points = await page.getByTestId('background-image').evaluate((image, target) => {
      const matrix = image.getScreenCTM();
      if (!matrix) throw new Error('image has no screen transform');
      const x = target === 'cabinet' ? 300 : 80;
      const y = target === 'cabinet' ? 300 : 200;
      return [new DOMPoint(x, y), new DOMPoint(x + 20, y + 20)].map((point) => {
        const screen = point.matrixTransform(matrix); return { x: screen.x, y: screen.y };
      });
    }, target);
    await page.mouse.move(points[0].x, points[0].y);
    await page.mouse.down();
    await page.mouse.move(points[1].x, points[1].y, { steps: 4 });
    await page.mouse.up();
    await expect(page.locator('svg[role=application] rect[style*="move"]')).toHaveCount(before.length + 1);
    await page.getByLabel('Save layout', { exact: true }).click();
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();
    await expect(page.getByTestId('background-image')).toHaveAttribute('opacity', '0.7');
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Remove background', exact: true }).click();
    await expect(page.getByTestId('background-image')).toHaveCount(0);
  });
}

test('cabinet and two drawer references retain independent transforms', async ({ page }) => {
  for (const [index, route] of [
    { path: '/cabinets/cab-1/design', feature: 'RenderCabinetDesigner' },
    { path: '/drawers/drawer-1/design', feature: 'RenderDrawerDesigner' },
    { path: '/drawers/drawer-2/design', feature: 'RenderDrawerDesigner' }
  ].entries()) {
    await open(page, route);
    await expect(page.getByRole('button', { name: 'Upload background' })).toBeEnabled();
    await page.locator('input[type=file]').setInputFiles({ name: `view-${index}.png`, mimeType: 'image/png', buffer: png });
    await expect(page.getByTestId('background-image')).toBeVisible();
    await page.getByLabel('Edit background image', { exact: true }).check();
    await page.getByLabel('Background opacity', { exact: true }).fill(String([0.2, 0.4, 0.6][index]));
    await page.getByRole('button', { name: 'Save background', exact: true }).click();
    await expect(page.getByText('Unsaved background changes', { exact: true })).toHaveCount(0);
  }
  for (const [index, route] of [
    { path: '/cabinets/cab-1/design', feature: 'RenderCabinetDesigner' },
    { path: '/drawers/drawer-1/design', feature: 'RenderDrawerDesigner' },
    { path: '/drawers/drawer-2/design', feature: 'RenderDrawerDesigner' }
  ].entries()) {
    await open(page, route);
    await expect(page.getByTestId('background-image')).toHaveAttribute('opacity', String([0.2, 0.4, 0.6][index]));
  }
});
