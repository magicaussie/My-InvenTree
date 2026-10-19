/**
 * Semantic command history for the layout editors.
 *
 * The editors keep the server snapshot (baseline) separate from an editable
 * draft. Every user edit is expressed as a **semantic command** (`add`, `move`,
 * `resize`, `bind`, `allocate`, `archive`, `batch`, ...). Undo/redo replays the
 * inverse or forward command, so history stays compact even for large layouts
 * and drags can be coalesced into a single entry (design sections 6 and 7).
 *
 * Commands only ever mutate the local draft: they never touch stock, native
 * locations or hardware.
 */

import {
  type AllocationInput,
  type BinInput,
  type DrawerInput,
  type LayoutDocument,
  type LayoutResponse,
  SCHEMA_VERSION
} from '../api/types';
import { moveRect, type Rect, rectsEqual } from './geometry';

export type EntityKind = 'drawer' | 'bin';

export interface DraftCabinet {
  width_units: number;
  height_units: number;
}

export type DrawerDraft = DrawerInput & { id: string; is_new?: boolean };
export type BinDraft = BinInput & { id: string; is_new?: boolean };

export interface LayoutDraft {
  cabinet: DraftCabinet;
  /** Drawers keyed by UUID. */
  drawers: Record<string, DrawerDraft>;
  /** Bins keyed by UUID. */
  bins: Record<string, BinDraft>;
  /** Insertion order for stable rendering of drawers without an explicit sort. */
  drawerOrder: string[];
  /** UUIDs the operator asked to archive on the next save. */
  archiveIds: string[];
}

export const MAX_HISTORY = 100;

/* ------------------------------------------------------------------ */
/* Draft construction                                                  */
/* ------------------------------------------------------------------ */

export function emptyDraft(
  cabinet: DraftCabinet = { width_units: 600, height_units: 800 }
): LayoutDraft {
  return {
    cabinet: { ...cabinet },
    drawers: {},
    bins: {},
    drawerOrder: [],
    archiveIds: []
  };
}

/** Build a draft from a layout API response. */
export function draftFromResponse(response: LayoutResponse): LayoutDraft {
  const draft = emptyDraft({
    width_units: response.cabinet.width_units,
    height_units: response.cabinet.height_units
  });

  for (const drawer of response.drawers) {
    if (!drawer.id) continue;
    draft.drawers[drawer.id] = { ...drawer, id: drawer.id };
    draft.drawerOrder.push(drawer.id);
  }

  for (const bin of response.bins) {
    if (!bin.id) continue;
    draft.bins[bin.id] = { ...bin, id: bin.id };
  }

  return draft;
}

/** Serialise a draft into the wire document accepted by `PUT .../layout/`. */
export function layoutFromDraft(draft: LayoutDraft): LayoutDocument {
  const drawers = draft.drawerOrder
    .map((id) => draft.drawers[id])
    .filter((drawer): drawer is DrawerDraft => Boolean(drawer));

  for (const id of Object.keys(draft.drawers)) {
    if (!draft.drawerOrder.includes(id)) {
      drawers.push(draft.drawers[id]);
    }
  }

  const bins = Object.values(draft.bins);

  return {
    schema_version: SCHEMA_VERSION,
    cabinet: {
      width_units: draft.cabinet.width_units,
      height_units: draft.cabinet.height_units
    },
    drawers: drawers.map(({ id, ...rest }) => ({ id, ...rest })),
    bins: bins.map(({ id, ...rest }) => ({ id, ...rest })),
    archive_ids: [...draft.archiveIds]
  };
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

export type Command =
  | { type: 'add_drawer'; drawer: DrawerDraft }
  | { type: 'add_bin'; bin: BinDraft }
  | { type: 'remove_drawer'; drawer: DrawerDraft }
  | { type: 'remove_bin'; bin: BinDraft }
  | {
      type: 'move';
      entity: EntityKind;
      deltas: Record<string, { dx: number; dy: number }>;
    }
  | {
      type: 'resize';
      entity: EntityKind;
      id: string;
      from: Rect;
      to: Rect;
    }
  | {
      type: 'bind';
      entity: EntityKind;
      id: string;
      from: number | null;
      to: number | null;
    }
  | {
      type: 'allocate';
      id: string;
      from: AllocationInput | null;
      to: AllocationInput | null;
    }
  | { type: 'archive'; entity: EntityKind; ids: string[] }
  | { type: 'restore'; entity: EntityKind; ids: string[] }
  | {
      type: 'set_field';
      entity: EntityKind;
      id: string;
      field: string;
      from: unknown;
      to: unknown;
    }
  | { type: 'set_cabinet'; from: DraftCabinet; to: DraftCabinet }
  | { type: 'batch'; commands: Command[] };

/** Return the inverse of a command (used for undo). */
export function invertCommand(command: Command): Command {
  switch (command.type) {
    case 'add_drawer':
      return { type: 'remove_drawer', drawer: command.drawer };
    case 'add_bin':
      return { type: 'remove_bin', bin: command.bin };
    case 'remove_drawer':
      return { type: 'add_drawer', drawer: command.drawer };
    case 'remove_bin':
      return { type: 'add_bin', bin: command.bin };
    case 'move': {
      const deltas: Record<string, { dx: number; dy: number }> = {};
      for (const [id, delta] of Object.entries(command.deltas)) {
        deltas[id] = { dx: -delta.dx, dy: -delta.dy };
      }
      return { type: 'move', entity: command.entity, deltas };
    }
    case 'resize':
      return {
        type: 'resize',
        entity: command.entity,
        id: command.id,
        from: command.to,
        to: command.from
      };
    case 'bind':
    case 'allocate':
    case 'set_field':
      return { ...command, from: command.to, to: command.from } as Command;
    case 'archive':
      return { type: 'restore', entity: command.entity, ids: command.ids };
    case 'restore':
      return { type: 'archive', entity: command.entity, ids: command.ids };
    case 'set_cabinet':
      return { type: 'set_cabinet', from: command.to, to: command.from };
    case 'batch':
      return {
        type: 'batch',
        commands: [...command.commands].reverse().map(invertCommand)
      };
  }
}

function applyRectCommand(
  draft: LayoutDraft,
  entity: EntityKind,
  id: string,
  rect: Rect
): void {
  const store = entity === 'drawer' ? draft.drawers : draft.bins;
  const row = store[id];
  if (!row) return;
  row.x = rect.x;
  row.y = rect.y;
  row.width = rect.width;
  row.height = rect.height;
}

/** Apply a single command to a draft. Pure: never mutates the input. */
export function applyCommand(
  draft: LayoutDraft,
  command: Command
): LayoutDraft {
  const next: LayoutDraft = {
    cabinet: { ...draft.cabinet },
    drawers: { ...draft.drawers },
    bins: { ...draft.bins },
    drawerOrder: [...draft.drawerOrder],
    archiveIds: [...draft.archiveIds]
  };

  switch (command.type) {
    case 'add_drawer':
      next.drawers[command.drawer.id] = { ...command.drawer };
      if (!next.drawerOrder.includes(command.drawer.id)) {
        next.drawerOrder.push(command.drawer.id);
      }
      break;
    case 'add_bin':
      next.bins[command.bin.id] = { ...command.bin };
      break;
    case 'remove_drawer':
      delete next.drawers[command.drawer.id];
      next.drawerOrder = next.drawerOrder.filter(
        (id) => id !== command.drawer.id
      );
      next.bins = Object.fromEntries(
        Object.entries(next.bins).filter(
          ([, bin]) => bin.drawer !== command.drawer.id
        )
      );
      next.archiveIds = next.archiveIds.filter(
        (id) => id !== command.drawer.id
      );
      break;
    case 'remove_bin':
      delete next.bins[command.bin.id];
      next.archiveIds = next.archiveIds.filter((id) => id !== command.bin.id);
      break;
    case 'move':
      for (const [id, delta] of Object.entries(command.deltas)) {
        const store = command.entity === 'drawer' ? next.drawers : next.bins;
        const row = store[id];
        if (!row) continue;
        store[id] = { ...row, ...moveRect(row, delta.dx, delta.dy) };
      }
      break;
    case 'resize':
      applyRectCommand(next, command.entity, command.id, command.to);
      break;
    case 'bind': {
      const store = command.entity === 'drawer' ? next.drawers : next.bins;
      const row = store[command.id];
      if (row) store[command.id] = { ...row, location: command.to };
      break;
    }
    case 'allocate': {
      const row = next.drawers[command.id];
      if (row) next.drawers[command.id] = { ...row, allocation: command.to };
      break;
    }
    case 'archive':
    case 'restore': {
      const archived = command.type === 'archive';
      const store = command.entity === 'drawer' ? next.drawers : next.bins;
      for (const id of command.ids) {
        const row = store[id];
        if (row) store[id] = { ...row, archived };
        if (archived && !next.archiveIds.includes(id)) {
          next.archiveIds.push(id);
        } else if (!archived) {
          next.archiveIds = next.archiveIds.filter((value) => value !== id);
        }
      }
      break;
    }
    case 'set_field': {
      const store = command.entity === 'drawer' ? next.drawers : next.bins;
      const row = store[command.id];
      if (row) {
        store[command.id] = {
          ...row,
          [command.field]: command.to
        } as DrawerDraft | BinDraft;
      }
      break;
    }
    case 'set_cabinet':
      next.cabinet = { ...command.to };
      break;
    case 'batch':
      return command.commands.reduce(
        (acc, inner) => applyCommand(acc, inner),
        next
      );
  }

  return next;
}

/* ------------------------------------------------------------------ */
/* Coalescing                                                          */
/* ------------------------------------------------------------------ */

/**
 * Coalesce two consecutive commands emitted during one interaction (e.g. a
 * single drag).
 *
 * Returns the merged command, or `null` when they cannot be combined.
 */
export function coalesceCommands(
  first: Command,
  second: Command
): Command | null {
  if (first.type !== second.type) {
    return null;
  }

  if (first.type === 'move' && second.type === 'move') {
    if (first.entity !== second.entity) return null;
    const deltas: Record<string, { dx: number; dy: number }> = {};
    for (const id of new Set([
      ...Object.keys(first.deltas),
      ...Object.keys(second.deltas)
    ])) {
      const a = first.deltas[id] ?? { dx: 0, dy: 0 };
      const b = second.deltas[id] ?? { dx: 0, dy: 0 };
      deltas[id] = { dx: a.dx + b.dx, dy: a.dy + b.dy };
    }
    return { type: 'move', entity: first.entity, deltas };
  }

  if (first.type === 'resize' && second.type === 'resize') {
    if (first.entity !== second.entity || first.id !== second.id) return null;
    if (!rectsEqual(first.to, second.from)) return null;
    return {
      type: 'resize',
      entity: first.entity,
      id: first.id,
      from: first.from,
      to: second.to
    };
  }

  if (first.type === 'set_cabinet' && second.type === 'set_cabinet') {
    return { type: 'set_cabinet', from: first.from, to: second.to };
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* History                                                             */
/* ------------------------------------------------------------------ */

export interface HistoryState {
  past: Command[];
  future: Command[];
}

/**
 * Bounded undo/redo history over a draft.
 *
 * The history owns the "present" draft. `apply` pushes a command; `undo` and
 * `redo` replay inverses. History is capped at {@link MAX_HISTORY} entries.
 */
export class LayoutHistory {
  present: LayoutDraft;
  private past: Command[] = [];
  private future: Command[] = [];

  constructor(draft: LayoutDraft) {
    this.present = draft;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  get depth(): number {
    return this.past.length;
  }

  /**
   * Apply a command.
   *
   * When `coalesceKey` matches the key recorded for the previous command, the
   * two commands are merged into a single history entry (used to collapse a
   * drag into one undo step). Any new edit clears the redo stack.
   */
  apply(command: Command, coalesceKey?: string): LayoutDraft {
    const previous = this.past[this.past.length - 1];

    if (
      coalesceKey &&
      this.lastCoalesceKey === coalesceKey &&
      previous &&
      this.future.length === 0
    ) {
      const merged = coalesceCommands(previous, command);
      if (merged) {
        this.present = applyCommand(this.present, command);
        this.past[this.past.length - 1] = merged;
        return this.present;
      }
    }

    this.present = applyCommand(this.present, command);
    this.past.push(command);
    this.future = [];
    this.lastCoalesceKey = coalesceKey;

    if (this.past.length > MAX_HISTORY) {
      this.past.shift();
    }

    return this.present;
  }

  private lastCoalesceKey: string | undefined;

  undo(): LayoutDraft {
    const command = this.past.pop();
    if (!command) return this.present;
    this.present = applyCommand(this.present, invertCommand(command));
    this.future.push(command);
    this.lastCoalesceKey = undefined;
    return this.present;
  }

  redo(): LayoutDraft {
    const command = this.future.pop();
    if (!command) return this.present;
    this.present = applyCommand(this.present, command);
    this.past.push(command);
    this.lastCoalesceKey = undefined;
    return this.present;
  }

  /** Replace the baseline after a successful save, clearing history. */
  reset(draft: LayoutDraft): void {
    this.present = draft;
    this.past = [];
    this.future = [];
    this.lastCoalesceKey = undefined;
  }
}
