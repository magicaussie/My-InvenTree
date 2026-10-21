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
  // Wait for scrolling, initial fit and hit testing before sampling coordinates.
  // Raw mouse input does not perform Playwright's actionability checks.
  await rect.click({ trial: true });
  const { start, delta } = await rect.evaluate((element, offset) => {
    const matrix = element.getScreenCTM();
    if (!matrix) throw new Error('entity has no screen transform');
    const bounds = element.getBBox();
    const point = new DOMPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2).matrixTransform(matrix);
    if (document.elementFromPoint(point.x, point.y) !== element) {
      throw new Error('entity drag start is intercepted');
    }
    return {
      start: { x: point.x, y: point.y },
      delta: {
        x: matrix.a * offset.dx + matrix.c * offset.dy,
        y: matrix.b * offset.dx + matrix.d * offset.dy
      }
    };
  }, { dx, dy });
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + delta.x, start.y + delta.y, { steps: 8 });
  await page.mouse.up();
}
