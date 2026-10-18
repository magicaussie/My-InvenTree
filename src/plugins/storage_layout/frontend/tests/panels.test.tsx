/**
 * Regression tests for the SVG overlay panels.
 *
 * These focus on {@link AllocationBands} segment geometry: the coloured
 * segment offset and width must be derived from the drawer's own logical
 * allocation length (`rangeCount(logicalStart, logicalEnd)`), not the
 * cabinet-wide `totalPixels`. They also assert the unsegmented fallback, the
 * logical-range label and that {@link CoverageRuler} is unaffected.
 */

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  AllocationBands,
  type AllocationRegion,
  CoverageRuler
} from '../src/components/editor/Panels';

const BACKGROUND_FILL = 'var(--mantine-color-gray-4)';
const FALLBACK_FILL = 'var(--mantine-color-green-6)';

function rectsIn(container: HTMLElement): SVGRectElement[] {
  return Array.from(container.querySelectorAll<SVGRectElement>('rect'));
}

function byFill(container: HTMLElement, fill: string): SVGRectElement[] {
  return rectsIn(container).filter(
    (rect) => rect.getAttribute('fill') === fill
  );
}

function geometry(rect: SVGRectElement) {
  return {
    x: Number(rect.getAttribute('x')),
    y: Number(rect.getAttribute('y')),
    width: Number(rect.getAttribute('width')),
    height: Number(rect.getAttribute('height'))
  };
}

describe('AllocationBands segment geometry', () => {
  it('scales 25%/75% segments to the drawer allocation, not totalPixels', () => {
    const region: AllocationRegion = {
      id: 'r1',
      rect: { x: 10, y: 10, width: 100, height: 20 },
      logicalStart: 101,
      logicalEnd: 200,
      segments: [
        { logical_start: 101, logical_end: 125, colour: '#ff0000' },
        { logical_start: 126, logical_end: 200, colour: '#00ff00' }
      ]
    };

    const { container } = render(
      <AllocationBands regions={[region]} totalPixels={500} />
    );

    const background = byFill(container, BACKGROUND_FILL);
    expect(background).toHaveLength(1);
    expect(geometry(background[0])).toMatchObject({ x: 12, width: 96 });

    const first = byFill(container, '#ff0000');
    const second = byFill(container, '#00ff00');
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);

    // 25/100 * 96 = 24 and 75/100 * 96 = 72, offset by 25/100 * 96 = 24.
    expect(geometry(first[0])).toMatchObject({ x: 12, width: 24 });
    expect(geometry(second[0])).toMatchObject({ x: 36, width: 72 });

    // Adjacent segments meet exactly and together fill the inner band.
    expect(geometry(first[0]).x + geometry(first[0]).width).toBe(
      geometry(second[0]).x
    );
    expect(geometry(second[0]).x + geometry(second[0]).width).toBe(
      geometry(background[0]).x + geometry(background[0]).width
    );
  });

  it('offsets an interior segment from a non-1 logical start', () => {
    const region: AllocationRegion = {
      id: 'r1',
      rect: { x: 10, y: 10, width: 100, height: 20 },
      logicalStart: 101,
      logicalEnd: 200,
      segments: [{ logical_start: 151, logical_end: 200, colour: '#0000ff' }]
    };

    const { container } = render(
      <AllocationBands regions={[region]} totalPixels={500} />
    );

    const segment = byFill(container, '#0000ff');
    expect(segment).toHaveLength(1);
    // (151 - 101) / 100 * 96 = 48 and 50 / 100 * 96 = 48.
    expect(geometry(segment[0])).toMatchObject({ x: 60, width: 48 });
  });

  it('fills the whole drawer allocation with a single segment regardless of totalPixels', () => {
    const region: AllocationRegion = {
      id: 'r1',
      rect: { x: 10, y: 10, width: 100, height: 20 },
      logicalStart: 1,
      logicalEnd: 100,
      segments: [{ logical_start: 1, logical_end: 100, colour: '#abcdef' }]
    };

    for (const totalPixels of [100, 500]) {
      const { container, unmount } = render(
        <AllocationBands regions={[region]} totalPixels={totalPixels} />
      );
      const segment = byFill(container, '#abcdef');
      expect(segment).toHaveLength(1);
      expect(geometry(segment[0])).toMatchObject({ x: 12, width: 96 });
      unmount();
    }
  });

  it('keeps the unsegmented fallback band and the logical-range label', () => {
    const region: AllocationRegion = {
      id: 'r1',
      rect: { x: 10, y: 10, width: 100, height: 20 },
      logicalStart: 1,
      logicalEnd: 100
    };

    const { container } = render(
      <AllocationBands regions={[region]} totalPixels={500} />
    );

    const fallback = byFill(container, FALLBACK_FILL);
    expect(fallback).toHaveLength(1);
    expect(geometry(fallback[0])).toMatchObject({ x: 12, width: 96 });

    expect(container.querySelector('text')?.textContent).toBe(
      'L1\u2013100 (100)'
    );
  });

  it('omits segments for a malformed logical range and never emits non-finite geometry', () => {
    const region: AllocationRegion = {
      id: 'r1',
      rect: { x: 10, y: 10, width: 100, height: 20 },
      logicalStart: 200,
      logicalEnd: 100,
      segments: [{ logical_start: 200, logical_end: 100, colour: '#ff0000' }]
    };

    const { container } = render(
      <AllocationBands regions={[region]} totalPixels={500} />
    );

    // Only the grey background band remains; the malformed segment is dropped.
    expect(byFill(container, '#ff0000')).toHaveLength(0);
    expect(byFill(container, BACKGROUND_FILL)).toHaveLength(1);

    for (const rect of rectsIn(container)) {
      const { x, y, width, height } = geometry(rect);
      for (const value of [x, y, width, height]) {
        expect(Number.isFinite(value)).toBe(true);
      }
      expect(width).toBeGreaterThanOrEqual(0);
    }
  });

  it('renders a zero-length segment as finite non-negative geometry', () => {
    const region: AllocationRegion = {
      id: 'r1',
      rect: { x: 10, y: 10, width: 100, height: 20 },
      logicalStart: 1,
      logicalEnd: 100,
      segments: [{ logical_start: 50, logical_end: 49, colour: '#ff0000' }]
    };

    const { container } = render(
      <AllocationBands regions={[region]} totalPixels={500} />
    );

    const segment = byFill(container, '#ff0000');
    expect(segment).toHaveLength(1);
    const { x, width } = geometry(segment[0]);
    expect(Number.isFinite(x)).toBe(true);
    expect(Number.isFinite(width)).toBe(true);
    expect(width).toBe(0);
  });

  it('omits segments when the drawer has no drawable inner width', () => {
    const region: AllocationRegion = {
      id: 'r1',
      rect: { x: 10, y: 10, width: 4, height: 20 },
      logicalStart: 1,
      logicalEnd: 100,
      segments: [{ logical_start: 1, logical_end: 100, colour: '#ff0000' }]
    };

    const { container } = render(
      <AllocationBands regions={[region]} totalPixels={500} />
    );

    expect(byFill(container, '#ff0000')).toHaveLength(0);
  });
});

describe('CoverageRuler', () => {
  it('still scales segments and unused ranges against totalPixels', () => {
    const { container } = render(
      <CoverageRuler
        totalPixels={100}
        width={200}
        y={5}
        unused={[{ logical_start: 26, logical_end: 50 }]}
        segments={[{ logical_start: 1, logical_end: 25, colour: '#123456' }]}
      />
    );

    const segment = byFill(container, '#123456');
    expect(segment).toHaveLength(1);
    expect(geometry(segment[0])).toMatchObject({ x: 0, width: 50 });

    const unused = byFill(container, 'url(#unused-hatch)');
    expect(unused).toHaveLength(1);
    expect(geometry(unused[0])).toMatchObject({ x: 50, width: 50 });
  });

  it('renders nothing when there are no logical pixels', () => {
    const { container } = render(
      <CoverageRuler totalPixels={0} width={200} y={5} unused={[]} />
    );
    expect(
      container.querySelector("[data-testid='coverage-ruler']")
    ).toBeNull();
  });
});
