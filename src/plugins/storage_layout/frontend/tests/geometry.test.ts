import { describe, expect, it } from 'vitest';

import {
  clampRect,
  findFreeDrawerPosition,
  fitViewport,
  fitZoom,
  isValidRect,
  MAX_ZOOM,
  MIN_ZOOM,
  moveRect,
  moveRects,
  rectInside,
  rectsEqual,
  rectsOverlap,
  resizeRect,
  snapRect,
  snapValue,
  translatedPan,
  validateMove,
  validateResize,
  viewportToCanvas,
  zoomAtPoint
} from '../src/state/geometry';

describe('viewport coordinates', () => {
  it.each([1, 0.5, 2])('maps dragging and resizing at zoom %s', (zoom) => {
    const viewport = { zoom, offsetX: 37, offsetY: -21 };
    const start = viewportToCanvas(
      { x: 10 * zoom + 37, y: 15 * zoom - 21 },
      viewport
    );
    const end = viewportToCanvas(
      { x: 30 * zoom + 37, y: 25 * zoom - 21 },
      viewport
    );
    expect(start).toEqual({ x: 10, y: 15 });
    expect(end).toEqual({ x: 30, y: 25 });
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const original = { x: 10, y: 15, width: 20, height: 20 };
    expect(moveRect(original, dx, dy)).toEqual({ ...original, x: 30, y: 25 });
    expect(resizeRect(original, 'se', dx, dy)).toEqual({
      ...original,
      width: 40,
      height: 30
    });
    expect(original).toEqual({ x: 10, y: 15, width: 20, height: 20 });
  });

  it.each([0.1, 0.5, 1, 2, 20])(
    'keeps the mouse anchor fixed when zooming to %s',
    (zoom) => {
      const viewport = { zoom: 1.3, offsetX: -72, offsetY: 43 };
      const pointer = { x: 145, y: 98 };
      const before = viewportToCanvas(pointer, viewport);
      const after = viewportToCanvas(
        pointer,
        zoomAtPoint(viewport, pointer, zoom)
      );
      expect(after.x).toBeCloseTo(before.x);
      expect(after.y).toBeCloseTo(before.y);
      expect(viewport).toEqual({ zoom: 1.3, offsetX: -72, offsetY: 43 });
    }
  );
});

describe('viewport navigation', () => {
  it.each([1, 0.5, 2])(
    'pans by exact screen pixels at zoom %s without mutating the origin',
    (zoom) => {
      const origin = Object.freeze({ zoom, offsetX: 13, offsetY: -29 });
      const start = Object.freeze({ x: 100, y: 50 });
      const moved = translatedPan(origin, start, { x: 137, y: 32 });
      expect(moved).toEqual({ zoom, offsetX: 50, offsetY: -47 });
      expect(translatedPan(origin, start, start)).toEqual(origin);
      expect(origin).toEqual({ zoom, offsetX: 13, offsetY: -29 });
    }
  );

  it('fits non-square model bounds in a non-square screen with centred padding', () => {
    const bounds = Object.freeze({ width: 600, height: 800 });
    const screen = Object.freeze({ width: 1000, height: 600 });
    const fitted = fitViewport(bounds, screen);
    expect(fitted).toEqual({ zoom: 0.69, offsetX: 293, offsetY: 24 });
    if (!fitted) throw new Error('Expected a fitted viewport');
    const centre = viewportToCanvas(
      { x: screen.width / 2, y: screen.height / 2 },
      fitted
    );
    expect(centre.x).toBeCloseTo(300);
    expect(centre.y).toBeCloseTo(400);
    expect(bounds).toEqual({ width: 600, height: 800 });
    expect(screen).toEqual({ width: 1000, height: 600 });
  });

  it('accounts for padding when width is the limiting dimension', () => {
    const fitted = fitViewport(
      { width: 800, height: 200 },
      { width: 1000, height: 600 }
    );
    expect(fitted?.zoom).toBeCloseTo(1.19);
    expect(fitted?.offsetX).toBeCloseTo(24);
    expect(fitted?.offsetY).toBeCloseTo(181);
    expect(
      fitViewport({ width: 800, height: 200 }, { width: 1000, height: 600 }, 0)
    ).toEqual({ zoom: 1.25, offsetX: 0, offsetY: 175 });
  });

  it.each([
    [{ width: 100000, height: 200000 }, MIN_ZOOM],
    [{ width: 1, height: 2 }, MAX_ZOOM]
  ] as const)('uses the same fit/zoom limits for %o', (bounds, zoom) => {
    const screen = { width: 800, height: 600 };
    expect(fitZoom(bounds, screen)).toBe(zoom);
    expect(fitViewport(bounds, screen)).toEqual({
      zoom,
      offsetX: (screen.width - bounds.width * zoom) / 2,
      offsetY: (screen.height - bounds.height * zoom) / 2
    });
  });

  it.each([
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY
  ])('ignores each invalid model/screen dimension: %s', (invalid) => {
    const valid = { width: 600, height: 400 };
    for (const key of ['width', 'height'] as const) {
      expect(fitViewport({ ...valid, [key]: invalid }, valid)).toBeNull();
      expect(fitViewport(valid, { ...valid, [key]: invalid })).toBeNull();
    }
  });

  it.each([MIN_ZOOM, MAX_ZOOM])(
    'does not drift when zoom is already at limit %s',
    (zoom) => {
      const original = Object.freeze({
        zoom,
        offsetX: 0.12345,
        offsetY: -987.654
      });
      const point = { x: 378.4, y: 281.5 };
      expect(zoomAtPoint(original, point, zoom)).toBe(original);
    }
  );
});

describe('findFreeDrawerPosition', () => {
  const bounds = { width: 600, height: 800 };
  const size = { width: 60, height: 40 };

  it('starts at the origin in an empty cabinet', () => {
    expect(findFreeDrawerPosition(bounds, size, [], 10)).toEqual({
      x: 0,
      y: 0
    });
  });

  it('places the next drawer against an occupied drawer without overlap', () => {
    const existing = [{ x: 0, y: 0, ...size }];
    const position = findFreeDrawerPosition(bounds, size, existing, 10);
    expect(position).toEqual({ x: 60, y: 0 });
    if (!position) throw new Error('Expected a free drawer position');
    expect(rectsOverlap({ ...position, ...size }, existing[0])).toBe(false);
  });

  it('scans left to right before advancing to the next free grid row', () => {
    const existing = [{ x: 0, y: 0, width: 600, height: 40 }];
    expect(findFreeDrawerPosition(bounds, size, existing, 10)).toEqual({
      x: 0,
      y: 40
    });
  });

  it('permits touching edges on multiple sides', () => {
    const existing = [
      { x: 0, y: 0, width: 60, height: 40 },
      { x: 60, y: 40, width: 60, height: 40 }
    ];
    const position = findFreeDrawerPosition(bounds, size, existing, 10);
    expect(position).toEqual({ x: 60, y: 0 });
    if (!position) throw new Error('Expected a free drawer position');
    expect(
      existing.every((rect) => !rectsOverlap({ ...position, ...size }, rect))
    ).toBe(true);
  });

  it.each([
    { width: 59, height: 800 },
    { width: 600, height: 39 }
  ])('returns null when the drawer cannot fit inside %o', (bounds) => {
    expect(findFreeDrawerPosition(bounds, size, [], 10)).toBeNull();
  });

  it('returns null when the cabinet is fully occupied', () => {
    expect(
      findFreeDrawerPosition(bounds, size, [{ x: 0, y: 0, ...bounds }], 10)
    ).toBeNull();
  });

  it('uses grid-aligned positions even when existing edges are off-grid', () => {
    const existing = [{ x: 0, y: 0, width: 65, height: 40 }];
    const position = findFreeDrawerPosition(bounds, size, existing, 10);
    expect(position).toEqual({ x: 70, y: 0 });
    if (!position) throw new Error('Expected a free drawer position');
    expect(position.x % 10).toBe(0);
    expect(position.y % 10).toBe(0);
  });

  it('does not use an off-grid gap or move already overlapping rectangles', () => {
    const existing = Object.freeze([
      Object.freeze({ x: 0, y: 0, width: 5, height: 40 }),
      Object.freeze({ x: 0, y: 0, width: 5, height: 40 })
    ]);
    expect(
      findFreeDrawerPosition({ width: 65, height: 40 }, size, existing, 10)
    ).toBeNull();
    expect(existing).toEqual([
      { x: 0, y: 0, width: 5, height: 40 },
      { x: 0, y: 0, width: 5, height: 40 }
    ]);
  });

  it.each([0, -10, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid grid spacing %s without looping',
    (grid) => {
      expect(findFreeDrawerPosition(bounds, size, [], grid)).toBeNull();
    }
  );
});

describe('isValidRect', () => {
  it('requires finite coordinates and positive area', () => {
    expect(isValidRect({ x: 0, y: 0, width: 1, height: 1 })).toBe(true);
    expect(isValidRect({ x: 0, y: 0, width: 0, height: 1 })).toBe(false);
    expect(isValidRect({ x: 0, y: 0, width: 1, height: -1 })).toBe(false);
    expect(isValidRect({ x: Number.NaN, y: 0, width: 1, height: 1 })).toBe(
      false
    );
    expect(
      isValidRect({ x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 1 })
    ).toBe(false);
  });
});

describe('validateMove', () => {
  const bounds = { width: 600, height: 800 };
  const rect = (x: number, y: number, width = 60, height = 40) => ({
    x,
    y,
    width,
    height
  });

  it('accepts a move into free space', () => {
    expect(
      validateMove({ a: rect(10, 0) }, { a: rect(0, 0) }, [], bounds)
    ).toBe(true);
  });

  it('rejects a move that overlaps a stationary drawer', () => {
    expect(
      validateMove({ a: rect(10, 0) }, { a: rect(0, 0) }, [rect(60, 0)], bounds)
    ).toBe(false);
  });

  it('accepts a move that touches a stationary drawer along an edge', () => {
    expect(
      validateMove(
        { a: rect(60, 0) },
        { a: rect(0, 0) },
        [rect(120, 0)],
        bounds
      )
    ).toBe(true);
  });

  it('rejects a move that leaves the cabinet bounds', () => {
    expect(
      validateMove({ a: rect(-10, 0) }, { a: rect(0, 0) }, [], bounds)
    ).toBe(false);
    expect(
      validateMove({ a: rect(550, 0) }, { a: rect(540, 0) }, [], bounds)
    ).toBe(false);
  });

  it('treats the moving set as simultaneous, ignoring their original positions', () => {
    const original = { a: rect(0, 0), b: rect(60, 0) };
    const proposed = { a: rect(60, 0), b: rect(120, 0) };
    expect(validateMove(proposed, original, [], bounds)).toBe(true);
  });

  it('rejects a new overlap between two moving drawers', () => {
    const original = { a: rect(0, 0), b: rect(200, 0) };
    const proposed = { a: rect(0, 0), b: rect(30, 0) };
    expect(validateMove(proposed, original, [], bounds)).toBe(false);
  });

  it('allows an unchanged pre-existing overlap between moving drawers', () => {
    const original = { a: rect(0, 0), b: rect(50, 0) };
    const proposed = { a: rect(10, 0), b: rect(60, 0) };
    expect(validateMove(proposed, original, [], bounds)).toBe(true);
  });

  it('rejects a new overlap with a stationary drawer while moving as a set', () => {
    const original = { a: rect(0, 0), b: rect(60, 0) };
    const proposed = { a: rect(60, 0), b: rect(120, 0) };
    expect(validateMove(proposed, original, [rect(120, 0)], bounds)).toBe(
      false
    );
  });

  it('rejects invalid rectangles', () => {
    expect(
      validateMove(
        { a: { x: 0, y: 0, width: 0, height: 40 } },
        { a: rect(0, 0) },
        [],
        bounds
      )
    ).toBe(false);
    expect(
      validateMove(
        { a: { x: Number.NaN, y: 0, width: 60, height: 40 } },
        { a: rect(0, 0) },
        [],
        bounds
      )
    ).toBe(false);
  });
});

describe('validateResize', () => {
  const bounds = { width: 600, height: 800 };
  const rect = (x: number, y: number, width = 60, height = 40) => ({
    x,
    y,
    width,
    height
  });

  it('accepts a resize that stays inside the cabinet and clear of others', () => {
    expect(
      validateResize(rect(0, 0, 70, 40), rect(0, 0), [rect(200, 0)], bounds)
    ).toBe(true);
  });

  it('accepts an edge-touching resize', () => {
    expect(
      validateResize(
        rect(0, 0, 60, 40),
        rect(0, 0, 50, 40),
        [rect(60, 0)],
        bounds
      )
    ).toBe(true);
  });

  it('rejects a resize that grows into another drawer', () => {
    expect(
      validateResize(rect(0, 0, 70, 40), rect(0, 0), [rect(60, 0)], bounds)
    ).toBe(false);
  });

  it('rejects an out-of-bounds or invalid rectangle', () => {
    expect(validateResize(rect(0, 0, 700, 40), rect(0, 0), [], bounds)).toBe(
      false
    );
    expect(validateResize(rect(0, 0, 0, 40), rect(0, 0), [], bounds)).toBe(
      false
    );
    expect(
      validateResize(
        { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 40 },
        rect(0, 0),
        [],
        bounds
      )
    ).toBe(false);
  });

  it('leaves a pre-existing collision untouched', () => {
    expect(
      validateResize(rect(0, 0, 60, 50), rect(0, 0), [rect(50, 0)], bounds)
    ).toBe(true);
  });
});

describe('geometry', () => {
  it('treats rectangles as half-open and rejects positive-area overlap', () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };
    // Touching edges are legal.
    expect(rectsOverlap(a, { x: 10, y: 0, width: 5, height: 5 })).toBe(false);
    expect(rectsOverlap(a, { x: 0, y: 10, width: 5, height: 5 })).toBe(false);
    // Positive-area overlap is rejected.
    expect(rectsOverlap(a, { x: 9, y: 9, width: 5, height: 5 })).toBe(true);
    // Zero-area rectangles never overlap.
    expect(rectsOverlap(a, { x: 0, y: 0, width: 0, height: 5 })).toBe(false);
  });

  it('checks containment with the half-open convention', () => {
    const outer = { x: 0, y: 0, width: 100, height: 100 };
    expect(rectInside({ x: 0, y: 0, width: 100, height: 100 }, outer)).toBe(
      true
    );
    expect(rectInside({ x: 90, y: 90, width: 10, height: 10 }, outer)).toBe(
      true
    );
    expect(rectInside({ x: 95, y: 0, width: 10, height: 10 }, outer)).toBe(
      false
    );
    expect(rectInside({ x: -1, y: 0, width: 10, height: 10 }, outer)).toBe(
      false
    );
  });

  it('snaps values and rectangles to the grid', () => {
    expect(snapValue(14, 10)).toBe(10);
    expect(snapValue(16, 10)).toBe(20);
    expect(snapRect({ x: 3, y: 4, width: 11, height: 9 }, 10)).toEqual({
      x: 0,
      y: 0,
      width: 10,
      height: 10
    });
  });

  it('moves and clamps rectangles inside the bounds', () => {
    const rect = { x: 5, y: 5, width: 10, height: 10 };
    expect(moveRect(rect, 3, -2)).toEqual({
      x: 8,
      y: 3,
      width: 10,
      height: 10
    });
    expect(
      clampRect(moveRect(rect, 200, 0), { width: 50, height: 50 })
    ).toEqual({
      x: 40,
      y: 5,
      width: 10,
      height: 10
    });
  });

  it('resizes from each handle while preserving minimum size', () => {
    const rect = { x: 10, y: 10, width: 20, height: 20 };
    expect(resizeRect(rect, 'e', 5, 0, { grid: 1 })).toEqual({
      x: 10,
      y: 10,
      width: 25,
      height: 20
    });
    // Dragging the west edge past the east edge yields a minimum size, not a
    // negative rectangle.
    const tiny = resizeRect(rect, 'w', 100, 0, { minSize: 2 });
    expect(tiny.width).toBe(2);
  });

  it('moves multiple rectangles by a shared offset', () => {
    const moved = moveRects(
      {
        a: { x: 0, y: 0, width: 1, height: 1 },
        b: { x: 5, y: 5, width: 1, height: 1 }
      },
      2,
      3
    );
    expect(moved.a).toEqual({ x: 2, y: 3, width: 1, height: 1 });
    expect(moved.b).toEqual({ x: 7, y: 8, width: 1, height: 1 });
  });

  it('compares rectangles and fits zoom deterministically', () => {
    expect(
      rectsEqual(
        { x: 1, y: 2, width: 3, height: 4 },
        { x: 1, y: 2, width: 3, height: 4 }
      )
    ).toBe(true);
    expect(
      fitZoom({ width: 100, height: 100 }, { width: 100, height: 100 }, 0)
    ).toBeCloseTo(1);
    expect(
      fitZoom({ width: 100, height: 100 }, { width: 200, height: 200 }, 0)
    ).toBeCloseTo(2);
  });
});
