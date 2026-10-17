import { describe, expect, it } from 'vitest';

import type { DrawerDraft, LayoutDraft } from '../src/state/commands';
import { emptyDraft } from '../src/state/commands';
import {
  computeUnusedRanges,
  diagnosticsByEntity,
  severityForEntity,
  validateDraft
} from '../src/state/validation';

function makeDraft(
  drawers: Partial<DrawerDraft>[],
  bins: {
    id: string;
    drawer: string;
    label: string;
    x: number;
    y: number;
    width: number;
    height: number;
    location?: number | null;
  }[] = []
): LayoutDraft {
  const draft = emptyDraft({ width_units: 200, height_units: 100 });
  drawers.forEach((override, index) => {
    const id = override.id ?? `d${index + 1}`;
    draft.drawers[id] = {
      id,
      label: override.label ?? `D${index + 1}`,
      display_number: override.display_number ?? index + 1,
      location: override.location === undefined ? 1 : override.location,
      x: override.x ?? 0,
      y: override.y ?? 0,
      width: override.width ?? 50,
      height: override.height ?? 50,
      interior_width: override.interior_width ?? 40,
      interior_height: override.interior_height ?? 40,
      archived: false,
      allocation: override.allocation ?? null
    };
    draft.drawerOrder.push(id);
  });
  bins.forEach((bin) => {
    draft.bins[bin.id] = {
      id: bin.id,
      drawer: bin.drawer,
      label: bin.label,
      location: bin.location === undefined ? 1 : bin.location,
      x: bin.x,
      y: bin.y,
      width: bin.width,
      height: bin.height,
      archived: false
    };
  });
  return draft;
}

describe('validation', () => {
  it('accepts a simple non-overlapping layout', () => {
    const draft = makeDraft([
      { id: 'd1', x: 0, y: 0, width: 50, height: 50 },
      { id: 'd2', x: 50, y: 0, width: 50, height: 50 }
    ]);
    const report = validateDraft(draft, 0);
    expect(report.errors).toHaveLength(0);
  });

  it('reports overlap with both drawer ids linked', () => {
    const draft = makeDraft([
      { id: 'd1', x: 0, y: 0, width: 60, height: 50 },
      { id: 'd2', x: 50, y: 0, width: 60, height: 50 }
    ]);
    const report = validateDraft(draft, 0);
    const overlap = report.errors.find(
      (error) => error.code === 'geometry_overlap'
    );
    expect(overlap).toBeDefined();
    expect(overlap?.related_ids).toEqual(expect.arrayContaining(['d1', 'd2']));
  });

  it('reports drawers outside the cabinet', () => {
    const draft = makeDraft([
      { id: 'd1', x: 180, y: 0, width: 50, height: 50 }
    ]);
    const report = validateDraft(draft, 0);
    expect(
      report.errors.some((error) => error.code === 'geometry_bounds')
    ).toBe(true);
  });

  it('detects duplicate display numbers and labels', () => {
    const draft = makeDraft([
      { id: 'd1', display_number: 1, label: 'A' },
      { id: 'd2', display_number: 1, label: 'A', x: 60 }
    ]);
    const report = validateDraft(draft, 0);
    expect(
      report.errors.some((error) => error.code === 'duplicate_number')
    ).toBe(true);
    expect(
      report.errors.some((error) => error.code === 'duplicate_label')
    ).toBe(true);
  });

  it('detects allocation overlap and bounds', () => {
    const draft = makeDraft([
      {
        id: 'd1',
        allocation: { logical_start: 1, logical_end: 30 }
      },
      {
        id: 'd2',
        x: 60,
        allocation: { logical_start: 20, logical_end: 60 }
      }
    ]);
    const report = validateDraft(draft, 50);
    expect(
      report.errors.some((error) => error.code === 'allocation_overlap')
    ).toBe(true);
    expect(
      report.errors.some((error) => error.code === 'allocation_bounds')
    ).toBe(true);
  });

  it('warns about unbound drawers and bins', () => {
    const draft = makeDraft(
      [{ id: 'd1', location: null }],
      [
        {
          id: 'b1',
          drawer: 'd1',
          label: 'B',
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          location: null
        }
      ]
    );
    const report = validateDraft(draft, 0);
    expect(
      report.warnings.some((warning) => warning.code === 'binding_missing')
    ).toBe(true);
    expect(
      report.warnings.some((warning) => warning.code === 'unbound_bin')
    ).toBe(true);
  });

  it('rejects a bin outside the drawer interior', () => {
    const draft = makeDraft(
      [{ id: 'd1', interior_width: 30, interior_height: 30 }],
      [
        {
          id: 'b1',
          drawer: 'd1',
          label: 'B',
          x: 25,
          y: 25,
          width: 10,
          height: 10
        }
      ]
    );
    const report = validateDraft(draft, 0);
    expect(
      report.errors.some((error) => error.code === 'geometry_bounds')
    ).toBe(true);
  });

  it('computes unused ranges and quantifies them as warnings', () => {
    expect(
      computeUnusedRanges([{ logical_start: 10, logical_end: 20 }], 30)
    ).toEqual([
      { logical_start: 1, logical_end: 9 },
      { logical_start: 21, logical_end: 30 }
    ]);
    const draft = makeDraft([
      { id: 'd1', allocation: { logical_start: 5, logical_end: 10 } }
    ]);
    const report = validateDraft(draft, 20);
    expect(report.unused_ranges).toEqual([
      { logical_start: 1, logical_end: 4 },
      { logical_start: 11, logical_end: 20 }
    ]);
    expect(
      report.warnings.some((warning) => warning.code === 'mapping_unused')
    ).toBe(true);
  });

  it('maps diagnostics back to entities with severities', () => {
    const draft = makeDraft([
      { id: 'd1', x: 0, y: 0, width: 60, height: 50 },
      { id: 'd2', x: 50, y: 0, width: 60, height: 50 }
    ]);
    const report = validateDraft(draft, 0);
    const map = diagnosticsByEntity(report);
    expect(severityForEntity(map, 'd1')).toBe('error');
    expect(severityForEntity(map, 'unknown')).toBeNull();
  });
});
