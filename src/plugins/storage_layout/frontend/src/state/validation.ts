/**
 * Client-side layout validation.
 *
 * This mirrors the authoritative server validator (`storage_layout/validation.py`)
 * closely enough to give immediate, non-colour-only feedback while editing. It
 * is **not** a substitute for the server check: every save is validated again
 * server-side, and the two are expected to agree.
 *
 * Diagnostics carry the UUIDs of the affected entities so the SVG canvas can
 * mark the geometry and the inspector can link a message back to its rectangle.
 */

import type {
  Diagnostic,
  DiagnosticSeverity,
  UnusedRange,
  ValidationReport
} from '../api/types';
import type { BinDraft, DrawerDraft, LayoutDraft } from './commands';
import { type Rect, rectInside, rectsOverlap } from './geometry';

export interface ClientValidation extends ValidationReport {
  unused_ranges: UnusedRange[];
}

export function isBlocking(diagnostic: Diagnostic): boolean {
  return diagnostic.severity === 'error';
}

export function hasBlockingErrors(report: ValidationReport): boolean {
  return report.errors.length > 0;
}

/** Return the UUIDs of the entities a diagnostic refers to. */
export function diagnosticIds(diagnostic: Diagnostic): string[] {
  return diagnostic.related_ids ?? [];
}

/** Compute the logical pixel ranges not covered by any active allocation. */
export function computeUnusedRanges(
  allocations: { logical_start: number; logical_end: number }[],
  totalPixels: number
): UnusedRange[] {
  if (totalPixels < 1 || allocations.length === 0) {
    return totalPixels >= 1
      ? [{ logical_start: 1, logical_end: totalPixels }]
      : [];
  }

  const sorted = [...allocations].sort(
    (a, b) => a.logical_start - b.logical_start
  );
  const unused: UnusedRange[] = [];
  let cursor = 1;

  for (const allocation of sorted) {
    if (allocation.logical_start > cursor) {
      unused.push({
        logical_start: cursor,
        logical_end: allocation.logical_start - 1
      });
    }
    cursor = Math.max(cursor, allocation.logical_end + 1);
  }

  if (cursor <= totalPixels) {
    unused.push({ logical_start: cursor, logical_end: totalPixels });
  }

  return unused;
}

function drawerRect(drawer: DrawerDraft): Rect {
  return {
    x: drawer.x,
    y: drawer.y,
    width: drawer.width,
    height: drawer.height
  };
}

function interiorRect(drawer: DrawerDraft): Rect {
  return {
    x: 0,
    y: 0,
    width: drawer.interior_width,
    height: drawer.interior_height
  };
}

function binRect(bin: BinDraft): Rect {
  return { x: bin.x, y: bin.y, width: bin.width, height: bin.height };
}

/**
 * Validate a draft.
 *
 * @param draft The editable layout draft.
 * @param totalPixels Mapping size `N` (0 when no mapping is published).
 */
export function validateDraft(
  draft: LayoutDraft,
  totalPixels: number
): ClientValidation {
  const errors: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];

  const activeDrawers = Object.values(draft.drawers).filter(
    (drawer) => !drawer.archived
  );
  const activeBins = Object.values(draft.bins).filter((bin) => !bin.archived);

  const cabinet: Rect = {
    x: 0,
    y: 0,
    width: draft.cabinet.width_units,
    height: draft.cabinet.height_units
  };

  /* ----------------------------- drawers ---------------------------- */

  const numberSeen = new Map<number, DrawerDraft>();
  const labelSeen = new Map<string, DrawerDraft>();

  for (const drawer of activeDrawers) {
    const rect = drawerRect(drawer);

    if (drawer.x < 0 || drawer.y < 0) {
      errors.push({
        code: 'geometry_bounds',
        severity: 'error',
        message: `Drawer ${drawer.label} has a negative position`,
        path: `drawers[${drawer.id}].x`,
        related_ids: [drawer.id]
      });
    }

    if (drawer.width < 1 || drawer.height < 1) {
      errors.push({
        code: 'geometry_bounds',
        severity: 'error',
        message: `Drawer ${drawer.label} must have positive dimensions`,
        path: `drawers[${drawer.id}].width`,
        related_ids: [drawer.id]
      });
    } else if (!rectInside(rect, cabinet)) {
      errors.push({
        code: 'geometry_bounds',
        severity: 'error',
        message: `Drawer ${drawer.label} extends outside the cabinet`,
        path: `drawers[${drawer.id}]`,
        related_ids: [drawer.id]
      });
    }

    if (drawer.interior_width < 1 || drawer.interior_height < 1) {
      errors.push({
        code: 'geometry_bounds',
        severity: 'error',
        message: `Drawer ${drawer.label} must have a positive interior`,
        path: `drawers[${drawer.id}].interior_width`,
        related_ids: [drawer.id]
      });
    }

    const previousNumber = numberSeen.get(drawer.display_number);
    if (previousNumber) {
      errors.push({
        code: 'duplicate_number',
        severity: 'error',
        message: `Display number ${drawer.display_number} is used by more than one drawer`,
        path: `drawers[${drawer.id}].display_number`,
        related_ids: [drawer.id, previousNumber.id]
      });
    } else {
      numberSeen.set(drawer.display_number, drawer);
    }

    const key = drawer.label.trim().toLowerCase();
    const previousLabel = labelSeen.get(key);
    if (previousLabel) {
      errors.push({
        code: 'duplicate_label',
        severity: 'error',
        message: `Drawer label "${drawer.label}" is not unique`,
        path: `drawers[${drawer.id}].label`,
        related_ids: [drawer.id, previousLabel.id]
      });
    } else {
      labelSeen.set(key, drawer);
    }

    if (drawer.location === null) {
      warnings.push({
        code: 'binding_missing',
        severity: 'warning',
        message: `Drawer ${drawer.label} is not bound to a native location`,
        path: `drawers[${drawer.id}].location`,
        related_ids: [drawer.id]
      });
    }
  }

  for (let i = 0; i < activeDrawers.length; i += 1) {
    for (let j = i + 1; j < activeDrawers.length; j += 1) {
      const a = activeDrawers[i];
      const b = activeDrawers[j];
      if (rectsOverlap(drawerRect(a), drawerRect(b))) {
        errors.push({
          code: 'geometry_overlap',
          severity: 'error',
          message: `Drawers ${a.label} and ${b.label} overlap`,
          related_ids: [a.id, b.id]
        });
      }
    }
  }

  /* -------------------------- allocations --------------------------- */

  const allocated: {
    drawer: DrawerDraft;
    logical_start: number;
    logical_end: number;
  }[] = [];

  for (const drawer of activeDrawers) {
    const allocation = drawer.allocation;
    if (!allocation) continue;

    if (
      allocation.logical_start < 1 ||
      allocation.logical_end < allocation.logical_start
    ) {
      errors.push({
        code: 'allocation_invalid',
        severity: 'error',
        message: `Drawer ${drawer.label} has an invalid logical range`,
        related_ids: [drawer.id]
      });
      continue;
    }

    if (totalPixels > 0 && allocation.logical_end > totalPixels) {
      errors.push({
        code: 'allocation_bounds',
        severity: 'error',
        message: `Drawer ${drawer.label} allocation exceeds the mapping size (${totalPixels})`,
        related_ids: [drawer.id]
      });
    }

    allocated.push({
      drawer,
      logical_start: allocation.logical_start,
      logical_end: allocation.logical_end
    });
  }

  for (let i = 0; i < allocated.length; i += 1) {
    for (let j = i + 1; j < allocated.length; j += 1) {
      const a = allocated[i];
      const b = allocated[j];
      if (
        a.logical_start <= b.logical_end &&
        b.logical_start <= a.logical_end
      ) {
        errors.push({
          code: 'allocation_overlap',
          severity: 'error',
          message: `Drawer allocations ${a.drawer.label} and ${b.drawer.label} overlap`,
          related_ids: [a.drawer.id, b.drawer.id]
        });
      }
    }
  }

  /* ------------------------------- bins ----------------------------- */

  const binsByDrawer = new Map<string, BinDraft[]>();

  for (const bin of activeBins) {
    const drawer = draft.drawers[bin.drawer];
    if (!drawer || drawer.archived) {
      errors.push({
        code: 'binding_invalid',
        severity: 'error',
        message: `Bin ${bin.label} references a missing drawer`,
        related_ids: [bin.id]
      });
      continue;
    }

    const list = binsByDrawer.get(bin.drawer) ?? [];
    list.push(bin);
    binsByDrawer.set(bin.drawer, list);

    if (!rectInside(binRect(bin), interiorRect(drawer))) {
      errors.push({
        code: 'geometry_bounds',
        severity: 'error',
        message: `Bin ${bin.label} lies outside the drawer interior`,
        path: `bins[${bin.id}]`,
        related_ids: [bin.id, drawer.id]
      });
    }

    if (bin.location === null) {
      warnings.push({
        code: 'unbound_bin',
        severity: 'warning',
        message: `Bin ${bin.label} is not bound to a native location and cannot be an inventory target`,
        related_ids: [bin.id]
      });
    }
  }

  for (const [drawerId, bins] of binsByDrawer) {
    const labelSeenByDrawer = new Map<string, BinDraft>();
    for (const bin of bins) {
      const key = bin.label.trim().toLowerCase();
      const previous = labelSeenByDrawer.get(key);
      if (previous) {
        errors.push({
          code: 'duplicate_label',
          severity: 'error',
          message: `Bin label "${bin.label}" is not unique within its drawer`,
          related_ids: [bin.id, previous.id]
        });
      } else {
        labelSeenByDrawer.set(key, bin);
      }
    }

    for (let i = 0; i < bins.length; i += 1) {
      for (let j = i + 1; j < bins.length; j += 1) {
        if (rectsOverlap(binRect(bins[i]), binRect(bins[j]))) {
          errors.push({
            code: 'geometry_overlap',
            severity: 'error',
            message: `Bins ${bins[i].label} and ${bins[j].label} overlap`,
            related_ids: [bins[i].id, bins[j].id, drawerId]
          });
        }
      }
    }
  }

  /* ---------------------------- unused LEDs ------------------------- */

  const unused_ranges =
    totalPixels > 0
      ? computeUnusedRanges(
          allocated.map(({ logical_start, logical_end }) => ({
            logical_start,
            logical_end
          })),
          totalPixels
        )
      : [];

  if (totalPixels > 0 && unused_ranges.length > 0) {
    warnings.push({
      code: 'mapping_unused',
      severity: 'warning',
      message: `${unused_ranges.length} unallocated LED range(s) between 1 and ${totalPixels}`,
      related_ids: []
    });
  }

  return {
    errors,
    warnings,
    unused_ranges
  };
}

/** Group diagnostics by the entity they affect for canvas rendering. */
export function diagnosticsByEntity(
  report: ValidationReport
): Map<string, Diagnostic[]> {
  const map = new Map<string, Diagnostic[]>();
  for (const diagnostic of [...report.errors, ...report.warnings]) {
    for (const id of diagnosticIds(diagnostic)) {
      const list = map.get(id) ?? [];
      list.push(diagnostic);
      map.set(id, list);
    }
  }
  return map;
}

/** Return the highest severity affecting an entity, if any. */
export function severityForEntity(
  map: Map<string, Diagnostic[]>,
  id: string
): DiagnosticSeverity | null {
  const list = map.get(id);
  if (!list || list.length === 0) return null;
  return list.some(isBlocking) ? 'error' : 'warning';
}
