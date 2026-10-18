/**
 * Integer geometry helpers for the SVG editors.
 *
 * Cabinet front-view and drawer bin geometry both use integer grid units with
 * a top-left origin (`x` right, `y` down). Rectangles are half-open
 * `[x, x + width) x [y, y + height)`, so touching edges are legal but any
 * positive-area overlap is rejected (design section 4.1).
 *
 * Everything in this module is pure and operates on plain objects, which keeps
 * it exhaustively unit-testable and independent of React.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Bounds {
  width: number;
  height: number;
}

/** The eight resize handles around a rectangle. */
export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export const RESIZE_HANDLES: ResizeHandle[] = [
  'nw',
  'n',
  'ne',
  'e',
  'se',
  's',
  'sw',
  'w'
];

/** Return true when two half-open rectangles overlap with positive area. */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  if (a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0) {
    return false;
  }
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

/** Return true when `inner` lies fully inside `outer` (half-open). */
export function rectInside(inner: Rect, outer: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/** Find the first free grid position, scanning rows from the top-left. */
export function findFreeDrawerPosition(
  bounds: Bounds,
  size: Bounds,
  existing: readonly Rect[],
  grid: number
): { x: number; y: number } | null {
  if (
    ![bounds.width, bounds.height, size.width, size.height, grid].every(
      (value) => Number.isFinite(value) && value > 0
    )
  ) {
    return null;
  }
  const cabinet = { x: 0, y: 0, ...bounds };
  for (let y = 0; y <= bounds.height - size.height; y += grid) {
    for (let x = 0; x <= bounds.width - size.width; x += grid) {
      const candidate = { x, y, ...size };
      if (
        rectInside(candidate, cabinet) &&
        !existing.some((rect) => rectsOverlap(candidate, rect))
      ) {
        return { x, y };
      }
    }
  }
  return null;
}

/** Integer rectangle equality. */
export function rectsEqual(a: Rect, b: Rect): boolean {
  return (
    a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
  );
}

/** Snap a single value to the nearest multiple of `grid`. */
export function snapValue(value: number, grid: number): number {
  if (grid <= 1) {
    return Math.round(value);
  }
  return Math.round(value / grid) * grid;
}

/** Snap every edge of a rectangle to the grid. */
export function snapRect(rect: Rect, grid: number): Rect {
  if (grid <= 1) {
    return roundRect(rect);
  }
  const x1 = snapValue(rect.x, grid);
  const y1 = snapValue(rect.y, grid);
  const x2 = snapValue(rect.x + rect.width, grid);
  const y2 = snapValue(rect.y + rect.height, grid);
  return {
    x: x1,
    y: y1,
    width: Math.max(1, x2 - x1),
    height: Math.max(1, y2 - y1)
  };
}

/** Round a rectangle to whole units. */
export function roundRect(rect: Rect): Rect {
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height))
  };
}

/** Translate a rectangle by an integer offset. */
export function moveRect(rect: Rect, dx: number, dy: number): Rect {
  return {
    ...rect,
    x: Math.round(rect.x + dx),
    y: Math.round(rect.y + dy)
  };
}

/** Clamp a rectangle so that it stays fully inside `bounds`. */
export function clampRect(rect: Rect, bounds: Bounds): Rect {
  const width = Math.min(Math.max(1, rect.width), bounds.width);
  const height = Math.min(Math.max(1, rect.height), bounds.height);
  return {
    x: Math.min(Math.max(0, rect.x), bounds.width - width),
    y: Math.min(Math.max(0, rect.y), bounds.height - height),
    width,
    height
  };
}

/**
 * Resize a rectangle by dragging `handle` through `(dx, dy)`.
 *
 * The opposite edge stays anchored, the minimum size is preserved, and the
 * result is snapped to the grid when enabled. The rectangle is *not* clamped
 * to any bounds here so the editor can preview an out-of-bounds candidate in
 * red before rejecting the commit.
 */
export function resizeRect(
  rect: Rect,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  options: { grid?: number; minSize?: number } = {}
): Rect {
  const grid = options.grid ?? 1;
  const minSize = options.minSize ?? 1;

  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.width;
  let bottom = rect.y + rect.height;

  if (handle.includes('w')) {
    left = rect.x + dx;
  }
  if (handle.includes('e')) {
    right = rect.x + rect.width + dx;
  }
  if (handle.includes('n')) {
    top = rect.y + dy;
  }
  if (handle.includes('s')) {
    bottom = rect.y + rect.height + dy;
  }

  left = snapValue(left, grid);
  top = snapValue(top, grid);
  right = snapValue(right, grid);
  bottom = snapValue(bottom, grid);

  if (right - left < minSize) {
    if (handle.includes('w')) {
      left = right - minSize;
    } else {
      right = left + minSize;
    }
  }
  if (bottom - top < minSize) {
    if (handle.includes('n')) {
      top = bottom - minSize;
    } else {
      bottom = top + minSize;
    }
  }

  return resizeFromEdges(left, top, right, bottom);
}

/** Build a rectangle from its four edges, allowing negative drags. */
export function resizeFromEdges(
  left: number,
  top: number,
  right: number,
  bottom: number
): Rect {
  const x = Math.min(left, right);
  const y = Math.min(top, bottom);
  return {
    x,
    y,
    width: Math.abs(right - left),
    height: Math.abs(bottom - top)
  };
}

/** Move a set of rectangles by a shared offset (multi-select translation). */
export function moveRects(
  rects: Record<string, Rect>,
  dx: number,
  dy: number
): Record<string, Rect> {
  const result: Record<string, Rect> = {};
  for (const [id, rect] of Object.entries(rects)) {
    result[id] = moveRect(rect, dx, dy);
  }
  return result;
}

/**
 * Clamp a multi-selection translation so that *every* rectangle stays inside
 * the bounds, keeping the selection's relative offsets intact.
 */
export function clampTranslation(
  rects: Rect[],
  bounds: Bounds,
  dx: number,
  dy: number
): { dx: number; dy: number } {
  let minDx = dx;
  let maxDx = dx;
  let minDy = dy;
  let maxDy = dy;

  for (const rect of rects) {
    maxDx = Math.min(maxDx, bounds.width - rect.width - rect.x);
    minDx = Math.max(minDx, -rect.x);
    maxDy = Math.min(maxDy, bounds.height - rect.height - rect.y);
    minDy = Math.max(minDy, -rect.y);
  }

  return {
    dx: Math.round(Math.min(Math.max(dx, minDx), maxDx)),
    dy: Math.round(Math.min(Math.max(dy, minDy), maxDy))
  };
}

export interface Viewport {
  zoom: number;
  offsetX: number;
  offsetY: number;
}

/** Invert the SVG viewport transform for a point relative to the SVG origin. */
export function viewportToCanvas(
  point: { x: number; y: number },
  viewport: Viewport
): { x: number; y: number } {
  return {
    x: (point.x - viewport.offsetX) / viewport.zoom,
    y: (point.y - viewport.offsetY) / viewport.zoom
  };
}

/** Change scale while keeping the canvas point beneath the pointer stationary. */
export function zoomAtPoint(
  viewport: Viewport,
  point: { x: number; y: number },
  zoom: number
): Viewport {
  const canvas = viewportToCanvas(point, viewport);
  return {
    zoom,
    offsetX: point.x - canvas.x * zoom,
    offsetY: point.y - canvas.y * zoom
  };
}

/** Convert a screen-space delta into canvas units using a zoom factor. */
export function screenToCanvasDelta(
  dxScreen: number,
  dyScreen: number,
  zoom: number
): { dx: number; dy: number } {
  const factor = zoom > 0 ? zoom : 1;
  return { dx: dxScreen / factor, dy: dyScreen / factor };
}

/** Fit a canvas of `bounds` into a viewport of `viewport` pixels. */
export function fitZoom(
  bounds: Bounds,
  viewport: { width: number; height: number },
  padding = 24
): number {
  const availableWidth = Math.max(1, viewport.width - padding * 2);
  const availableHeight = Math.max(1, viewport.height - padding * 2);
  const zoom = Math.min(
    availableWidth / Math.max(1, bounds.width),
    availableHeight / Math.max(1, bounds.height)
  );
  return Math.max(0.05, Math.min(20, zoom));
}
