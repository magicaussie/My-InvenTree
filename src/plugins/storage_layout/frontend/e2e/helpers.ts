import type { Page } from '@playwright/test';

/** Options for loading a plugin entry in the browser harness. */
export interface OpenOptions {
  /** URL path (supplies the route id used by `routeId()`). */
  path: string;
  /** Export name to render (e.g. `RenderCabinetDesigner`). */
  feature: string;
  /** `large` seeds the 500-drawer / 2,000-bin performance fixture. */
  seed?: 'large';
  /** Fake `context.instance`. */
  instance?: unknown;
  /** Fake `context.model`. */
  model?: string;
  /** Fake `context.id`. */
  id?: number;
}

/**
 * Load the built plugin bundle through the harness and wait until it has
 * rendered.
 */
export async function open(page: Page, options: OpenOptions) {
  const params = new URLSearchParams({ mode: 'bundle', feature: options.feature });

  if (options.seed) params.set('seed', options.seed);
  if (options.instance) params.set('instance', JSON.stringify(options.instance));
  if (options.model) params.set('model', options.model);
  if (options.id !== undefined) params.set('id', String(options.id));

  await page.goto(`${options.path}?${params.toString()}`);
  await page.waitForFunction(
    () => (window as unknown as { __ready?: boolean }).__ready === true,
    undefined,
    { timeout: 20000 }
  );
}

export interface RecordedCall {
  method: string;
  url: string;
  body: Record<string, any>;
  headers?: Record<string, string>;
}

/** Read the mock API's recorded calls from the page. */
export function recordedCalls(page: Page): Promise<RecordedCall[]> {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          __mock: { calls: RecordedCall[] };
        }
      ).__mock.calls
  );
}

/** Drag by logical canvas units, independent of fit and zoom. */
export async function dragFirstEntity(page: Page, dx: number, dy: number) {
  const rect = page.locator('rect[style*="move"]').first();
  const box = await rect.boundingBox();
  if (!box) throw new Error('entity rectangle has no bounding box');

  const startX = box.x + Math.min(8, box.width / 4);
  const startY = box.y + Math.min(8, box.height / 4);

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  const delta = await rect.evaluate((element, offset) => {
    const matrix = element.getScreenCTM();
    if (!matrix) throw new Error('entity has no screen transform');
    return {
      x: matrix.a * offset.dx + matrix.c * offset.dy,
      y: matrix.b * offset.dx + matrix.d * offset.dy
    };
  }, { dx, dy });
  await page.mouse.move(startX + delta.x, startY + delta.y, { steps: 8 });
  await page.mouse.up();
}
