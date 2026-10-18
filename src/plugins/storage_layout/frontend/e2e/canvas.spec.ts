import { expect, test } from '@playwright/test';

import { open, recordedCalls } from './helpers';

test.beforeEach(async ({ page }) => {
  await open(page, {
    path: '/cabinets/cab-1/design',
    feature: 'RenderCabinetDesigner'
  });
  await expect(page.getByTestId('cabinet-designer')).toBeVisible();
});

test('zoom keeps painted bounds and allocation overlays aligned and background clears selection', async ({
  page
}) => {
  const svg = page.getByRole('application', { name: 'Cabinet front view' });
  const entity = svg.locator('rect[style*="move"]').first();
  await page.getByLabel('Zoom in', { exact: true }).click();
  await page.getByTestId('drawer-list').getByRole('button').first().click();
  await expect(svg.locator('rect[style*="se-resize"]')).toHaveCount(1);
  const aligned = await svg.evaluate((element) => {
    const entity = element.querySelector('rect[style*="move"]');
    const background = element.querySelector(
      'rect[stroke="var(--mantine-color-gray-5)"]'
    );
    const bands = element.querySelector('[data-testid="allocation-bands"]');
    const group = entity?.closest('g[transform]');
    return Boolean(
      group &&
        background?.closest('g[transform]') === group &&
        bands?.closest('g[transform]') === group
    );
  });
  expect(aligned).toBe(true);
  // Empty painted cabinet space, not the unpainted exterior of the SVG.
  const point = await entity.evaluate((element) => {
    const group = element.closest('g[transform]') as SVGGElement;
    const point = new DOMPoint(400, 30).matrixTransform(group.getScreenCTM()!);
    return { x: point.x, y: point.y };
  });
  await page.mouse.click(point.x, point.y);
  await expect(svg.locator('rect[style*="se-resize"]')).toHaveCount(0);
});

test('zoomed resize retains SVG capture, Escape cancels, and the next resize saves once', async ({
  page
}) => {
  const svg = page.getByRole('application', { name: 'Cabinet front view' });
  const entity = svg.locator('rect[style*="move"]').first();
  await page.getByLabel('Zoom in', { exact: true }).click();
  await page.getByTestId('drawer-list').getByRole('button').first().click();
  const handle = svg.locator('rect[style*="se-resize"]').first();
  const box = await handle.boundingBox();
  if (!box) throw new Error('resize handle has no bounding box');
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const width = Number(await entity.getAttribute('width'));
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 24, start.y, { steps: 4 });
  await expect(entity).toHaveAttribute('width', String(width + 20));
  expect(
    await svg.evaluate((element) =>
      (element as SVGSVGElement).hasPointerCapture(1)
    )
  ).toBe(true);
  await page.keyboard.press('Escape');
  expect(
    await svg.evaluate((element) =>
      (element as SVGSVGElement).hasPointerCapture(1)
    )
  ).toBe(false);
  await page.mouse.up();
  await expect(entity).toHaveAttribute('width', String(width));
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  expect(
    (await recordedCalls(page)).filter((call) => call.method === 'PUT')
  ).toHaveLength(0);

  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 24, start.y, { steps: 4 });
  await page.mouse.up();
  await expect(entity).toHaveAttribute('width', String(width + 20));
  await page.getByLabel('Save layout').click();
  const puts = (await recordedCalls(page)).filter(
    (call) => call.method === 'PUT'
  );
  expect(puts).toHaveLength(1);
  const drawers = puts[0].body.drawers as { id: string; width: number }[];
  expect(drawers.find((drawer) => drawer.id === 'drawer-1')?.width).toBe(
    width + 20
  );
});
