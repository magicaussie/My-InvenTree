import { describe, expect, it } from 'vitest';

import {
  applyCommand,
  type BinDraft,
  coalesceCommands,
  type DrawerDraft,
  emptyDraft,
  invertCommand,
  LayoutHistory,
  layoutFromDraft,
  MAX_HISTORY
} from '../src/state/commands';

function drawer(overrides: Partial<DrawerDraft> = {}): DrawerDraft {
  return {
    id: 'd1',
    label: 'A1',
    display_number: 1,
    location: null,
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    interior_width: 90,
    interior_height: 40,
    archived: false,
    allocation: null,
    ...overrides
  };
}

function bin(overrides: Partial<BinDraft> = {}): BinDraft {
  return {
    id: 'b1',
    drawer: 'd1',
    label: 'B1',
    location: null,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    archived: false,
    ...overrides
  };
}

describe('commands', () => {
  it('adds a drawer and removes it on undo', () => {
    const base = emptyDraft();
    const added = applyCommand(base, { type: 'add_drawer', drawer: drawer() });
    expect(Object.keys(added.drawers)).toHaveLength(1);
    const undone = applyCommand(
      added,
      invertCommand({ type: 'add_drawer', drawer: drawer() })
    );
    expect(Object.keys(undone.drawers)).toHaveLength(0);
    expect(base.drawers).toEqual({});
  });

  it('coalesces consecutive moves of the same entity', () => {
    const merged = coalesceCommands(
      { type: 'move', entity: 'drawer', deltas: { d1: { dx: 1, dy: 0 } } },
      { type: 'move', entity: 'drawer', deltas: { d1: { dx: 2, dy: 3 } } }
    );
    expect(merged).toEqual({
      type: 'move',
      entity: 'drawer',
      deltas: { d1: { dx: 3, dy: 3 } }
    });
  });

  it('coalesces a resize only when the rectangles are contiguous', () => {
    const first = {
      type: 'resize' as const,
      entity: 'drawer' as const,
      id: 'd1',
      from: { x: 0, y: 0, width: 10, height: 10 },
      to: { x: 0, y: 0, width: 12, height: 10 }
    };
    const second = {
      type: 'resize' as const,
      entity: 'drawer' as const,
      id: 'd1',
      from: { x: 0, y: 0, width: 12, height: 10 },
      to: { x: 0, y: 0, width: 15, height: 10 }
    };
    expect(coalesceCommands(first, second)).toEqual({
      type: 'resize',
      entity: 'drawer',
      id: 'd1',
      from: first.from,
      to: second.to
    });
    const disjoint = { ...second, from: { x: 0, y: 0, width: 99, height: 10 } };
    expect(coalesceCommands(first, disjoint)).toBeNull();
  });

  it('inverts batches in reverse order', () => {
    const batch = {
      type: 'batch' as const,
      commands: [
        { type: 'add_drawer' as const, drawer: drawer() },
        { type: 'add_bin' as const, bin: bin() }
      ]
    };
    const inverse = invertCommand(batch);
    expect(inverse.type).toBe('batch');
    if (inverse.type === 'batch') {
      expect(inverse.commands[0].type).toBe('remove_bin');
      expect(inverse.commands[1].type).toBe('remove_drawer');
    }
  });

  it('archives and restores, tracking archive ids', () => {
    const base = applyCommand(emptyDraft(), {
      type: 'add_drawer',
      drawer: drawer()
    });
    const archived = applyCommand(base, {
      type: 'archive',
      entity: 'drawer',
      ids: ['d1']
    });
    expect(archived.drawers.d1.archived).toBe(true);
    expect(archived.archiveIds).toContain('d1');
    const restored = applyCommand(archived, {
      type: 'restore',
      entity: 'drawer',
      ids: ['d1']
    });
    expect(restored.drawers.d1.archived).toBe(false);
    expect(restored.archiveIds).not.toContain('d1');
  });

  it('tracks undo/redo through the history', () => {
    const history = new LayoutHistory(emptyDraft());
    history.apply({ type: 'add_drawer', drawer: drawer() });
    expect(history.canUndo).toBe(true);
    expect(history.canRedo).toBe(false);
    const undone = history.undo();
    expect(Object.keys(undone.drawers)).toHaveLength(0);
    expect(history.canRedo).toBe(true);
    const redone = history.redo();
    expect(Object.keys(redone.drawers)).toHaveLength(1);
  });

  it('clears the redo stack on a new edit', () => {
    const history = new LayoutHistory(emptyDraft());
    history.apply({ type: 'add_drawer', drawer: drawer() });
    history.undo();
    expect(history.canRedo).toBe(true);
    history.apply({ type: 'add_drawer', drawer: drawer({ id: 'd2' }) });
    expect(history.canRedo).toBe(false);
  });

  it('coalesces a drag into a single undo entry', () => {
    const history = new LayoutHistory(emptyDraft());
    history.apply({ type: 'add_drawer', drawer: drawer() });
    for (let i = 0; i < 5; i += 1) {
      history.apply(
        { type: 'move', entity: 'drawer', deltas: { d1: { dx: 1, dy: 0 } } },
        'move:d1'
      );
    }
    expect(history.present.drawers.d1.x).toBe(5);
    history.undo();
    expect(history.present.drawers.d1.x).toBe(0);
  });

  it('caps history length', () => {
    const history = new LayoutHistory(emptyDraft());
    for (let i = 1; i <= MAX_HISTORY + 20; i += 1) {
      history.apply({ type: 'add_drawer', drawer: drawer({ id: `d${i}` }) });
    }
    expect(history.depth).toBeLessThanOrEqual(MAX_HISTORY);
  });

  it('serialises a draft into a layout document', () => {
    const draft = applyCommand(emptyDraft(), {
      type: 'add_drawer',
      drawer: drawer()
    });
    const withBin = applyCommand(draft, { type: 'add_bin', bin: bin() });
    const document = layoutFromDraft(withBin);
    expect(document.schema_version).toBe(1);
    expect(document.drawers).toHaveLength(1);
    expect(document.bins).toHaveLength(1);
    expect(document.archive_ids).toEqual([]);
  });
});
