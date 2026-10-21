import { type Locator, type Page, expect, test } from '@playwright/test';

import { open, recordedCalls } from './helpers';

// CDP sends real touch input through Chromium's hit testing and pointer capture,
// unlike dispatchEvent(), which bypasses both and cannot expose scroll takeover.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

async function geometry(entity: Locator) {
  return entity.evaluate((element) => Object.fromEntries(
    ['x', 'y', 'width', 'height'].map((key) => [key, Number(element.getAttribute(key))])
  ));
}

async function gesture(page: Page, entity: Locator, target: Locator, input: 'pointer' | 'touch', dx: number, dy: number, cancel = false) {
  const svg = page.getByRole('application');
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error('gesture target has no bounds');
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const delta = await entity.evaluate((element, offset) => {
    const matrix = element.getScreenCTM()!;
    return { x: matrix.a * offset.dx, y: matrix.d * offset.dy };
  }, { dx, dy });
  // Fail explicitly if clipping or a pane intercepts the intended start point.
  expect(await target.evaluate((element, point) => document.elementFromPoint(point.x, point.y) === element, start)).toBe(true);
  await svg.evaluate((element) => element.addEventListener('pointerdown', (event) => {
    element.setAttribute('data-test-pointer-id', String((event as PointerEvent).pointerId));
  }, { capture: true, once: true }));
  const session = input === 'touch' ? await page.context().newCDPSession(page) : null;
  if (session) {
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...start, id: 1 }] });
  } else {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
  }
  for (let step = 1; step <= 5; step++) {
    const point = { x: start.x + delta.x * step / 5, y: start.y + delta.y * step / 5 };
    if (session) await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...point, id: 1 }] });
    else await page.mouse.move(point.x, point.y);
  }
  expect(await svg.evaluate((element) => (element as SVGSVGElement).hasPointerCapture(Number(element.getAttribute('data-test-pointer-id'))))).toBe(true);
  if (cancel && !session) await page.keyboard.press('Escape');
  if (session) {
    await session.send('Input.dispatchTouchEvent', { type: cancel ? 'touchCancel' : 'touchEnd', touchPoints: [] });
    await session.detach();
  } else await page.mouse.up();
  expect(await svg.evaluate((element) => (element as SVGSVGElement).hasPointerCapture(Number(element.getAttribute('data-test-pointer-id'))))).toBe(false);
}

for (const target of ['drawer', 'bin'] as const) {
  for (const input of ['pointer', 'touch'] as const) {
    test(`390px ${input} ${target} move, resize, cancellation and CAS save preserve locked background`, async ({ page }) => {
      await open(page, target === 'drawer'
        ? { path: '/cabinets/cab-1/design', feature: 'RenderCabinetDesigner' }
        : { path: '/drawers/drawer-1/design', feature: 'RenderDrawerDesigner' });
      await page.locator('input[type=file]').setInputFiles({
        name: 'gesture.png', mimeType: 'image/png',
        buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6HkAAAAASUVORK5CYII=', 'base64')
      });
      const image = page.getByTestId('background-image');
      await expect(image).toBeVisible();
      await page.getByLabel('Edit background image', { exact: true }).check();
      await expect(page.getByLabel('Lock background', { exact: true })).toBeChecked();
      await page.getByLabel('Edit background image', { exact: true }).uncheck();
      const imageBefore = await image.evaluate((element) => element.outerHTML);
      const svg = page.getByRole('application');
      const entities = svg.locator('rect[style*="move"]');
      const entity = entities.first();
      const before = await geometry(entity);
      const others = await entities.evaluateAll((elements) => elements.slice(1).map((element) => element.outerHTML));
      await gesture(page, entity, entity, input, 20, 10);
      await expect(entity).toHaveAttribute('x', String(before.x + 20));
      await expect(entity).toHaveAttribute('y', String(before.y + 10));
      await page.getByLabel('Undo', { exact: true }).click();
      await expect(entity).toHaveAttribute('x', String(before.x));
      await page.getByLabel('Redo', { exact: true }).click();
      await expect(entity).toHaveAttribute('x', String(before.x + 20));
      const moved = await geometry(entity);
      const handle = svg.locator('rect[style*="se-resize"]');
      await gesture(page, entity, handle, input, 10, 10, true);
      expect(await geometry(entity)).toEqual(moved);
      await gesture(page, entity, handle, input, 10, 10);
      await expect(entity).toHaveAttribute('width', String(before.width + 10));
      await expect(entity).toHaveAttribute('height', String(before.height + 10));
      expect(await entities.evaluateAll((elements) => elements.slice(1).map((element) => element.outerHTML))).toEqual(others);
      expect(await image.evaluate((element) => element.outerHTML)).toBe(imageBefore);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      await page.getByLabel('Save layout', { exact: true }).click();
      await expect(page.getByText('Saved', { exact: true })).toBeVisible();
      const calls = await recordedCalls(page);
      const puts = calls.filter((call) => call.method === 'PUT');
      expect(puts).toHaveLength(1);
      expect(puts[0].headers?.['If-Match']).toBe('"4"');
      const rows = puts[0].body[target === 'drawer' ? 'drawers' : 'bins'];
      expect(rows.find((row: { id: string }) => row.id === `${target}-1`)).toMatchObject({
        x: before.x + 20, y: before.y + 10, width: before.width + 10, height: before.height + 10
      });
      expect(calls.filter((call) => ['PATCH', 'DELETE'].includes(call.method) && call.url.includes('/background/'))).toHaveLength(0);
    });
  }
}
