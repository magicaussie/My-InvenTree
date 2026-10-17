import { describe, expect, it } from 'vitest';

import type { BinDraft } from '../src/state/commands';
import { generateGrid, gridToBins } from '../src/state/grid';

function existingBin(overrides: Partial<BinDraft>): BinDraft {
  return {
    id: overrides.id ?? 'b',
    drawer: 'd1',
    label: overrides.label ?? 'B',
    location: null,
    x: overrides.x ?? 0,
    y: overrides.y ?? 0,
    width: overrides.width ?? 10,
    height: overrides.height ?? 10,
    archived: false
  };
}

describe('grid generator', () => {
  it('divides the interior evenly', () => {
    const preview = generateGrid({
      interior: { width: 100, height: 50 },
      columns: 2,
      rows: 1,
      gutter: 0
    });
    expect(preview.cells).toHaveLength(2);
    expect(preview.totalWidth).toBe(100);
    expect(preview.totalHeight).toBe(50);
    expect(preview.fits).toBe(true);
    expect(preview.cells[1].rect).toEqual({
      x: 50,
      y: 0,
      width: 50,
      height: 50
    });
  });

  it('applies gutters and margins', () => {
    const preview = generateGrid({
      interior: { width: 100, height: 100 },
      columns: 2,
      rows: 2,
      gutter: 10,
      margin: 5
    });
    // Available space is 90x90; two 40-wide cells plus a 10 gutter.
    expect(preview.cells[0].rect).toEqual({
      x: 5,
      y: 5,
      width: 40,
      height: 40
    });
    expect(preview.cells[1].rect.x).toBe(55);
    expect(preview.fits).toBe(true);
  });

  it('never overwrites existing bins and reports collisions', () => {
    const preview = generateGrid(
      {
        interior: { width: 100, height: 50 },
        columns: 2,
        rows: 1,
        gutter: 0
      },
      [existingBin({ x: 0, y: 0, width: 50, height: 50 })]
    );
    expect(preview.cells).toHaveLength(1);
    expect(preview.collisions).toHaveLength(1);
    expect(preview.cells[0].rect.x).toBe(50);
  });

  it('flags a grid which does not fit', () => {
    const preview = generateGrid({
      interior: { width: 20, height: 20 },
      columns: 5,
      rows: 5,
      gutter: 0,
      cellWidth: 5,
      cellHeight: 5
    });
    expect(preview.fits).toBe(false);
  });

  it('builds labelled bin drafts', () => {
    const preview = generateGrid({
      interior: { width: 100, height: 50 },
      columns: 2,
      rows: 1,
      gutter: 0
    });
    let counter = 0;
    const bins = gridToBins(preview, {
      drawerId: 'd1',
      labelPrefix: 'B-',
      newId: () => `id-${counter++}`
    });
    expect(bins.map((bin) => bin.label)).toEqual(['B-01', 'B-02']);
    expect(bins.every((bin) => bin.drawer === 'd1')).toBe(true);
    expect(bins.every((bin) => bin.location === null)).toBe(true);
  });
});
