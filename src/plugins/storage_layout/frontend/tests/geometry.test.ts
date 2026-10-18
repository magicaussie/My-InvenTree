import { describe, expect, it } from 'vitest';

import {
  clampRect,
  findFreeDrawerPosition,
  fitZoom,
  moveRect,
  moveRects,
  rectInside,
  rectsEqual,
  rectsOverlap,
  resizeRect,
  snapRect,
  snapValue,
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
