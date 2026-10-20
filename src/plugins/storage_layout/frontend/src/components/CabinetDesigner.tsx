/**
 * Cabinet designer (`cabinets/:id/design`).
 *
 * Three panes: a focusable drawer list, the SVG front-view canvas (with
 * allocation bands and a coverage ruler) and a property/validation inspector.
 * Additional tabs expose the electrical topology, the mapping preview/publish
 * tools and the simulation/diagnostic controls.
 *
 * All edits are local draft commands; nothing is sent to the server until the
 * operator presses Save, and nothing ever touches hardware from this screen
 * (except the explicitly approved actions on the Diagnostics tab).
 */

import type { InvenTreePluginContext } from '@inventreedb/ui';
import { t } from '@lingui/core/macro';
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  NumberInput,
  Paper,
  ScrollArea,
  Select,
  Stack,
  Tabs,
  Text,
  UnstyledButton
} from '@mantine/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StorageLayoutClient } from '../api/client';
import type { Diagnostic } from '../api/types';
import {
  type Command,
  type DrawerDraft,
  layoutFromDraft
} from '../state/commands';
import {
  findFreeDrawerPosition,
  moveRects,
  type Rect,
  rectsOverlap,
  validateMove,
  validateResize
} from '../state/geometry';
import { useDirtyUnloadGuard, useLayoutEditor } from '../state/layoutDraft';
import { topologyFromDocument } from '../state/mapping';
import { diagnosticsByEntity, severityForEntity } from '../state/validation';
import { formatRange, newId, rangeCount } from '../utils';
import { type CanvasEntity, EditorCanvas } from './editor/EditorCanvas';
import { FunctionColorsPanel } from './editor/FunctionColorsPanel';
import { DrawerInspector } from './editor/Inspector';
import { MappingPanel } from './editor/MappingPanel';
import {
  ArchiveConfirmModal,
  ConflictModal,
  RenumberModal
} from './editor/Modals';
import {
  AllocationBands,
  type AllocationRegion,
  CoverageRuler,
  ValidationPanel
} from './editor/Panels';
import { SimulationPanel } from './editor/SimulationPanel';
import { EditorToolbar } from './editor/Toolbar';
import { TopologyEditor } from './editor/TopologyEditor';
import { type StructureDocument, StructureEditor } from './StructureEditor';
import {
  containsRect,
  fitOpening,
  projectStructure
} from '../state/structureReference';

export interface CabinetDesignerProps {
  context: InvenTreePluginContext;
  cabinetId: string;
}

function drawerRect(drawer: DrawerDraft): Rect {
  return {
    x: drawer.x,
    y: drawer.y,
    width: drawer.width,
    height: drawer.height
  };
}

export function CabinetDesigner({ context, cabinetId }: CabinetDesignerProps) {
  const editor = useLayoutEditor({ api: context.api, cabinetId });
  const client = useMemo(
    () => new StorageLayoutClient(context.api),
    [context.api]
  );

  const [activeTab, setActiveTab] = useState<string | null>('layout');
  const [reference, setReference] = useState<StructureDocument | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [loadingReference, setLoadingReference] = useState(false);
  const projected = reference
    ? projectStructure(reference, {
        width: editor.draft.cabinet.width_units,
        height: editor.draft.cabinet.height_units
      })
    : [];
  const openings = projected.filter((feature) => feature.type === 'opening');
  const selectedOpening = openings.find((feature) => feature.id === openingId);
  const referenceRequest = useRef(0);
  const loadReference = async () => {
    const request = ++referenceRequest.current;
    setLoadingReference(true);
    try {
      const { data } = await client.getCabinet(cabinetId);
      if (request !== referenceRequest.current) return;
      const structure =
        (data as typeof data & { structure?: StructureDocument | null })
          .structure ?? null;
      setReference(structure);
      setOpeningId(null);
      setServerMessage(
        structure
          ? t`Saved structure loaded as a visual reference. No drawer geometry was changed.`
          : t`No saved structure. Create and save one in Cabinet / Structure first.`
      );
    } catch (error) {
      if (request === referenceRequest.current)
        setServerMessage((error as Error).message);
    } finally {
      if (request === referenceRequest.current) setLoadingReference(false);
    }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: Cabinet identity changes must clear the session-local guide even though the reset uses no cabinet fields.
  useEffect(() => {
    setReference(null);
    setOpeningId(null);
    setLoadingReference(false);
    return () => {
      referenceRequest.current++;
    };
  }, [cabinetId]);
  const [snap, setSnap] = useState(true);
  const [grid, setGrid] = useState(10);
  const [propertiesOpen, setPropertiesOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);

  const [renumberOpen, setRenumberOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [serverMessage, setServerMessage] = useState<string | null>(null);
  const [topology, setTopology] = useState<
    ReturnType<typeof topologyFromDocument>
  >(new Map());

  // A stable array identity for the topology. Spreading the map inline on every
  // render would hand the mapping/simulation panels a new array each time the
  // parent re-renders (for example after a publish refresh), which resets their
  // candidate state and clears the publish confirmation.
  const topologyList = useMemo(() => [...topology.values()], [topology]);

  useDirtyUnloadGuard(editor.dirty);

  // Load electrical topology once so allocation bands and the mapping panel can
  // resolve controller/string boundaries. Read-only: never triggers hardware.
  useEffect(() => {
    let cancelled = false;
    client
      .getElectrical(cabinetId)
      .then((result) => {
        if (cancelled) return;
        setTopology(topologyFromDocument(result.data.controllers ?? []));
      })
      .catch(() => {
        /* topology is optional for layout editing */
      });
    return () => {
      cancelled = true;
    };
  }, [cabinetId, client]);

  const drawers = useMemo(
    () => Object.values(editor.draft.drawers),
    [editor.draft.drawers]
  );

  const activeDrawers = drawers.filter((drawer) => !drawer.archived);

  const selected = useMemo(
    () =>
      editor.selection.map((id) => editor.draft.drawers[id]).filter(Boolean),
    [editor.selection, editor.draft.drawers]
  );

  const diagnostics = useMemo(
    () => diagnosticsByEntity(editor.validation),
    [editor.validation]
  );

  const entities = useMemo<CanvasEntity[]>(
    () =>
      drawers.map((drawer) => {
        const allocation = drawer.allocation;
        return {
          id: drawer.id,
          label: `${drawer.display_number}. ${drawer.label}`,
          rect: drawerRect(drawer),
          archived: drawer.archived,
          severity: severityForEntity(diagnostics, drawer.id),
          detail: allocation
            ? `L${formatRange(allocation.logical_start, allocation.logical_end)} (${rangeCount(allocation.logical_start, allocation.logical_end)})`
            : drawer.archived
              ? 'archived'
              : 'unlit'
        };
      }),
    [drawers, diagnostics]
  );

  const regions = useMemo<AllocationRegion[]>(() => {
    const result: AllocationRegion[] = [];
    for (const drawer of activeDrawers) {
      const allocation = drawer.allocation;
      if (!allocation) continue;
      result.push({
        id: drawer.id,
        rect: drawerRect(drawer),
        logicalStart: allocation.logical_start,
        logicalEnd: allocation.logical_end
      });
    }
    return result;
  }, [activeDrawers]);

  const selectionIds = editor.selection;

  const validateWithServer = useCallback(async () => {
    setServerMessage(null);
    try {
      const result = await client.validateLayout(
        cabinetId,
        layoutFromDraft(editor.draft)
      );
      setServerMessage(
        result.valid
          ? t`Server validation: ${result.errors.length} error(s), ${result.warnings.length} warning(s) — no blocking errors.`
          : t`Server validation: ${result.errors.length} error(s), ${result.warnings.length} warning(s) — blocking errors found.`
      );
    } catch (error) {
      setServerMessage((error as Error).message);
    }
  }, [client, cabinetId, editor.draft]);

  const onMove = useCallback(
    (ids: string[], dx: number, dy: number) => {
      // Only active drawers move: missing and archived ids are ignored so an
      // archived drawer is never silently relocated.
      const moving: Record<string, Rect> = {};
      for (const id of ids) {
        const drawer = editor.draft.drawers[id];
        if (!drawer || drawer.archived) continue;
        moving[id] = drawerRect(drawer);
      }
      const movingIds = Object.keys(moving);
      if (movingIds.length === 0 || (dx === 0 && dy === 0)) return;

      const bounds = {
        width: editor.draft.cabinet.width_units,
        height: editor.draft.cabinet.height_units
      };
      const movingSet = new Set(movingIds);
      const stationary = activeDrawers
        .filter((drawer) => !movingSet.has(drawer.id))
        .map(drawerRect);

      if (
        !validateMove(moveRects(moving, dx, dy), moving, stationary, bounds)
      ) {
        setServerMessage(
          t`Cannot move drawers: placement overlaps another drawer or exceeds cabinet bounds.`
        );
        return;
      }

      setServerMessage(null);
      const deltas: Record<string, { dx: number; dy: number }> = {};
      for (const id of movingIds) deltas[id] = { dx, dy };
      editor.apply({ type: 'move', entity: 'drawer', deltas });
    },
    [activeDrawers, editor]
  );

  const onResize = useCallback(
    (id: string, rect: Rect) => {
      // Archived drawers are read-only for geometry: never resize them.
      const drawer = editor.draft.drawers[id];
      if (!drawer || drawer.archived) return;
      const bounds = {
        width: editor.draft.cabinet.width_units,
        height: editor.draft.cabinet.height_units
      };
      const original = drawerRect(drawer);
      const others = activeDrawers
        .filter((other) => other.id !== id)
        .map(drawerRect);

      if (!validateResize(rect, original, others, bounds)) {
        setServerMessage(
          t`Cannot resize drawer: placement overlaps another drawer or exceeds cabinet bounds.`
        );
        return;
      }

      setServerMessage(null);
      editor.apply({
        type: 'resize',
        entity: 'drawer',
        id,
        from: original,
        to: rect
      });
    },
    [activeDrawers, editor]
  );

  const addDrawer = useCallback(
    (drawn?: Rect) => {
      const bounds = {
        width: editor.draft.cabinet.width_units,
        height: editor.draft.cabinet.height_units
      };
      if (drawn && selectedOpening && !containsRect(selectedOpening, drawn)) {
        setServerMessage(
          t`The drawn drawer must fit inside the selected opening. Clear the opening selection for free placement.`
        );
        return;
      }
      const size = drawn
        ? { width: drawn.width, height: drawn.height }
        : {
            width: Math.min(grid * 6, bounds.width),
            height: Math.min(grid * 4, bounds.height)
          };
      const position = drawn
        ? drawn
        : findFreeDrawerPosition(
            bounds,
            size,
            activeDrawers.map(drawerRect),
            grid
          );
      if (!position) {
        setServerMessage(t`Insufficient free space to add a drawer.`);
        return;
      }
      if (
        drawn &&
        (drawn.x < 0 ||
          drawn.y < 0 ||
          drawn.width < 1 ||
          drawn.height < 1 ||
          drawn.x + drawn.width > bounds.width ||
          drawn.y + drawn.height > bounds.height ||
          activeDrawers.some((drawer) =>
            rectsOverlap(drawn, drawerRect(drawer))
          ))
      ) {
        setServerMessage(
          t`The drawn drawer must fit inside the cabinet without overlapping another drawer.`
        );
        return;
      }
      setServerMessage(null);
      const display_numbers = activeDrawers.map(
        (drawer) => drawer.display_number
      );
      const next = display_numbers.length
        ? Math.max(...display_numbers) + 1
        : 1;
      const drawer: DrawerDraft = {
        id: newId(),
        is_new: true,
        label: `D${next}`,
        display_number: next,
        location: null,
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        interior_width: size.width,
        interior_height: size.height,
        archived: false,
        allocation: null
      };
      editor.apply({ type: 'add_drawer', drawer });
      editor.setSelection([drawer.id]);
    },
    [activeDrawers, editor, grid, selectedOpening]
  );

  const duplicateSelection = useCallback(() => {
    // Only active drawers can be duplicated; archived or missing selections are
    // ignored. Nothing is mutated until every copy has a valid placement, so a
    // failed duplication leaves the draft, selection and history untouched.
    const sources = selected.filter((drawer) => !drawer.archived);
    if (sources.length === 0) return;

    const bounds = {
      width: editor.draft.cabinet.width_units,
      height: editor.draft.cabinet.height_units
    };
    const occupied = activeDrawers.map(drawerRect);
    const placements: Array<{ drawer: DrawerDraft; x: number; y: number }> = [];
    for (const drawer of sources) {
      const position = findFreeDrawerPosition(
        bounds,
        { width: drawer.width, height: drawer.height },
        occupied,
        grid
      );
      if (!position) {
        setServerMessage(
          t`Insufficient free space to duplicate the selected drawers.`
        );
        return;
      }
      // Reserve the new rectangle so later copies cannot overlap it.
      occupied.push({
        ...position,
        width: drawer.width,
        height: drawer.height
      });
      placements.push({ drawer, ...position });
    }

    setServerMessage(null);
    const numbers = activeDrawers.map((drawer) => drawer.display_number);
    let next = numbers.length ? Math.max(...numbers) : 0;
    const commands: Command[] = [];
    const newIds: string[] = [];
    for (const { drawer, x, y } of placements) {
      next += 1;
      const copy: DrawerDraft = {
        ...drawer,
        id: newId(),
        is_new: true,
        label: `${drawer.label} copy`,
        display_number: next,
        // Duplicate copies geometry/style only: no native location, no LEDs.
        location: null,
        allocation: null,
        archived: false,
        x,
        y
      };
      commands.push({ type: 'add_drawer', drawer: copy });
      newIds.push(copy.id);
    }
    editor.apply({ type: 'batch', commands });
    editor.setSelection(newIds);
  }, [activeDrawers, editor, grid, selected]);

  const archiveSelection = useCallback(() => {
    if (selected.some((drawer) => !drawer.archived)) setArchiveOpen(true);
  }, [selected]);

  const arrangeSelection = useCallback(
    (mode: 'left' | 'right' | 'top' | 'bottom' | 'horizontal' | 'vertical') => {
      const items = selected.filter((drawer) => !drawer.archived);
      if (items.length < 2) return;
      const horizontal =
        mode === 'left' || mode === 'right' || mode === 'horizontal';
      const sorted = [...items].sort((a, b) =>
        horizontal
          ? a.x - b.x || a.id.localeCompare(b.id)
          : a.y - b.y || a.id.localeCompare(b.id)
      );
      const min = Math.min(
        ...items.map((item) => (horizontal ? item.x : item.y))
      );
      const max = Math.max(
        ...items.map((item) =>
          horizontal ? item.x + item.width : item.y + item.height
        )
      );
      const start = horizontal ? sorted[0].x : sorted[0].y;
      const endItem = sorted[sorted.length - 1];
      const end = horizontal
        ? endItem.x + endItem.width
        : endItem.y + endItem.height;
      const totalSize = sorted.reduce(
        (sum, item) => sum + (horizontal ? item.width : item.height),
        0
      );
      let cursor = start;
      const deltas: Record<string, { dx: number; dy: number }> = {};
      for (const item of sorted) {
        const target =
          mode === 'left'
            ? min
            : mode === 'right'
              ? max - item.width
              : mode === 'top'
                ? min
                : mode === 'bottom'
                  ? max - item.height
                  : cursor;
        const position = snap
          ? Math.round(target / grid) * grid
          : Math.round(target);
        deltas[item.id] = horizontal
          ? { dx: position - item.x, dy: 0 }
          : { dx: 0, dy: position - item.y };
        if (mode === 'horizontal')
          cursor +=
            item.width + (end - start - totalSize) / (sorted.length - 1);
        if (mode === 'vertical')
          cursor +=
            item.height + (end - start - totalSize) / (sorted.length - 1);
      }
      const moving = Object.fromEntries(
        items.map((item) => [item.id, drawerRect(item)])
      );
      const stationary = activeDrawers
        .filter((item) => !moving[item.id])
        .map(drawerRect);
      const next = moveRects(moving, 0, 0);
      for (const [id, delta] of Object.entries(deltas)) {
        next[id] = {
          ...next[id],
          x: next[id].x + delta.dx,
          y: next[id].y + delta.dy
        };
      }
      if (
        !validateMove(next, moving, stationary, {
          width: editor.draft.cabinet.width_units,
          height: editor.draft.cabinet.height_units
        })
      ) {
        setServerMessage(
          t`Cannot arrange selection: the result would overlap another drawer or exceed cabinet bounds.`
        );
        return;
      }
      setServerMessage(null);
      editor.apply({ type: 'move', entity: 'drawer', deltas });
    },
    [activeDrawers, editor, grid, selected, snap]
  );

  const confirmArchive = useCallback(() => {
    const commands: Command[] = [];
    const baselineIds = new Set(editor.draft.drawerOrder);
    for (const id of selectionIds) {
      const drawer = editor.draft.drawers[id];
      if (!drawer) continue;
      // New (unsaved) drawers are removed; persisted drawers are archived.
      if (baselineIds.has(id)) {
        commands.push({ type: 'archive', entity: 'drawer', ids: [id] });
      } else {
        commands.push({ type: 'remove_drawer', drawer });
      }
    }
    if (commands.length) {
      editor.apply(
        commands.length === 1 ? commands[0] : { type: 'batch', commands }
      );
    }
    editor.setSelection([]);
    setArchiveOpen(false);
  }, [editor, selectionIds]);

  const affectedBins = useMemo(() => {
    const ids = new Set(selectionIds);
    return Object.values(editor.draft.bins).filter((bin) =>
      ids.has(bin.drawer)
    );
  }, [editor.draft.bins, selectionIds]);

  const handleRenumber = useCallback(
    (assignments: { id: string; display_number: number }[]) => {
      const commands: Command[] = assignments
        .filter(({ id, display_number }) => {
          const drawer = editor.draft.drawers[id];
          return drawer && drawer.display_number !== display_number;
        })
        .map(({ id, display_number }) => ({
          type: 'set_field' as const,
          entity: 'drawer' as const,
          id,
          field: 'display_number',
          from: editor.draft.drawers[id]?.display_number,
          to: display_number
        }));
      if (commands.length) editor.apply({ type: 'batch', commands });
      setRenumberOpen(false);
    },
    [editor]
  );

  // Keyboard shortcuts for the whole designer.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const typing =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable;
      if (typing || activeTab !== 'layout') return;

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) editor.redo();
        else editor.undo();
      } else if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === 's'
      ) {
        event.preventDefault();
        void editor.save();
      } else if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === 'd'
      ) {
        event.preventDefault();
        duplicateSelection();
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        if (selectionIds.length) {
          event.preventDefault();
          archiveSelection();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [
    activeTab,
    archiveSelection,
    duplicateSelection,
    editor,
    selectionIds.length
  ]);

  const openLocation = useCallback(
    (locationId: number) => {
      context.navigate(`/stock/location/${locationId}`);
    },
    [context]
  );

  const selectedDrawer = selected.length === 1 ? selected[0] : null;
  const conflictDiagnostics: Diagnostic[] = [];

  if (editor.status === 'loading') {
    return <Text p='md'>{t`Loading cabinet layout…`}</Text>;
  }

  if (editor.status === 'error') {
    return (
      <Alert m='md' color='red' title={t`Unable to load cabinet`}>
        {editor.error ?? t`Unknown error`}
      </Alert>
    );
  }

  return (
    <Stack gap='sm' p='sm' data-testid='cabinet-designer'>
      <Group justify='space-between'>
        <Group gap='xs'>
          <Text fw={700} size='lg'>
            {editor.cabinet?.name ?? t`Cabinet`}
          </Text>
          <Badge variant='light'>{t`revision ${editor.revision ?? '-'}`}</Badge>
          {editor.status === 'readonly' ? (
            <Badge color='orange'>{t`Read-only`}</Badge>
          ) : null}
          <Badge
            color={editor.cabinet?.location ? 'green' : 'yellow'}
            variant='light'
            aria-label={t`Native stock location status`}
          >
            {editor.cabinet?.location
              ? t`Stock location linked`
              : t`No stock location`}
          </Badge>
          {editor.activeMapping ? (
            <Badge color='teal' variant='light'>
              {t`mapping N=${editor.totalPixels}`}
            </Badge>
          ) : (
            <Badge color='gray' variant='light'>
              {t`no mapping`}
            </Badge>
          )}
        </Group>
      </Group>

      <EditorToolbar
        readOnly={editor.status !== 'ready'}
        dirty={editor.dirty}
        saving={editor.saving}
        canUndo={editor.canUndo}
        canRedo={editor.canRedo}
        snap={snap}
        grid={grid}
        onToggleSnap={setSnap}
        onGridChange={setGrid}
        onAdd={() => addDrawer()}
        addLabel={t`Add drawer`}
        onDuplicate={duplicateSelection}
        duplicateDisabled={selected.length === 0}
        onArchive={archiveSelection}
        archiveLabel={t`Archive`}
        archiveDisabled={selected.length === 0}
        onUndo={editor.undo}
        onRedo={editor.redo}
        onValidate={() => void validateWithServer()}
        onRenumber={() => setRenumberOpen(true)}
        onSave={() => void editor.save()}
        onRevert={editor.revert}
      />

      {editor.error && !editor.conflict ? (
        <Alert color='red' title={t`Save failed`} role='alert'>
          <Stack gap={4}>
            <Text>{editor.error}</Text>
            <Text size='sm'>
              {/network|request failed|timeout|failed to fetch/i.test(
                editor.error
              )
                ? t`Check your connection and sign-in, then retry. Your draft remains unsaved.`
                : t`Your draft remains unsaved. Check the response above, correct the issue if needed, then retry or copy the error for your administrator.`}
            </Text>
          </Stack>
        </Alert>
      ) : null}

      {serverMessage ? (
        <Alert
          color='blue'
          withCloseButton
          onClose={() => setServerMessage(null)}
        >
          {serverMessage}
        </Alert>
      ) : null}

      <Tabs value={activeTab} onChange={setActiveTab}>
        <Tabs.List>
          <Tabs.Tab value='layout'>{t`Drawers and Bins`}</Tabs.Tab>
          <Tabs.Tab value='structure'>{t`Cabinet / Structure`}</Tabs.Tab>
          <Tabs.Tab value='topology'>{t`Topology`}</Tabs.Tab>
          <Tabs.Tab value='mapping'>{t`Mapping`}</Tabs.Tab>
          <Tabs.Tab value='colors'>{t`Colors`}</Tabs.Tab>
          <Tabs.Tab value='diagnostics'>{t`Diagnostics`}</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value='layout' pt='sm'>
          <Group align='stretch' gap='sm' wrap='wrap' style={{ minWidth: 0 }}>
            <Paper withBorder p='xs' w={220} style={{ flexShrink: 0 }}>
              <Stack gap='xs'>
                <Button
                  variant='subtle'
                  size='compact-sm'
                  aria-expanded={propertiesOpen}
                  onClick={() => setPropertiesOpen((open) => !open)}
                >
                  {propertiesOpen
                    ? t`Hide cabinet properties`
                    : t`Show cabinet properties`}
                </Button>
                {propertiesOpen ? (
                  <>
                    <Text size='sm' fw={600}>
                      {t`Cabinet properties`}
                    </Text>
                    <Group grow gap='xs'>
                      <NumberInput
                        label={t`Width (logical units)`}
                        min={1}
                        max={100000}
                        value={editor.draft.cabinet.width_units}
                        disabled={editor.status !== 'ready'}
                        onChange={(value) => {
                          const width = Number(value);
                          if (
                            !Number.isInteger(width) ||
                            width < 1 ||
                            width > 100000
                          )
                            return;
                          const from = editor.draft.cabinet;
                          editor.apply(
                            {
                              type: 'set_cabinet',
                              from,
                              to: { ...from, width_units: width }
                            },
                            'cabinet-dimensions'
                          );
                        }}
                        aria-label={t`Cabinet width in logical units`}
                      />
                      <NumberInput
                        label={t`Height (logical units)`}
                        min={1}
                        max={100000}
                        value={editor.draft.cabinet.height_units}
                        disabled={editor.status !== 'ready'}
                        onChange={(value) => {
                          const height = Number(value);
                          if (
                            !Number.isInteger(height) ||
                            height < 1 ||
                            height > 100000
                          )
                            return;
                          const from = editor.draft.cabinet;
                          editor.apply(
                            {
                              type: 'set_cabinet',
                              from,
                              to: { ...from, height_units: height }
                            },
                            'cabinet-dimensions'
                          );
                        }}
                        aria-label={t`Cabinet height in logical units`}
                      />
                    </Group>
                    {activeDrawers.some(
                      (drawer) =>
                        drawer.x < 0 ||
                        drawer.y < 0 ||
                        drawer.x + drawer.width >
                          editor.draft.cabinet.width_units ||
                        drawer.y + drawer.height >
                          editor.draft.cabinet.height_units
                    ) ? (
                      <Alert color='orange' p='xs' role='status'>
                        {t`One or more drawers extend beyond these cabinet bounds. Their saved positions were not changed.`}
                      </Alert>
                    ) : null}
                  </>
                ) : null}
                <Text size='sm' fw={600} mt='sm'>
                  {t`Drawers`}
                </Text>
                <ScrollArea h={420} type='auto'>
                  <Stack gap={2} data-testid='drawer-list'>
                    {activeDrawers.map((drawer) => (
                      <UnstyledButton
                        key={drawer.id}
                        aria-label={t`Drawer ${drawer.label}`}
                        aria-selected={editor.selection.includes(drawer.id)}
                        onClick={(event) =>
                          editor.toggleSelection(
                            drawer.id,
                            event.shiftKey || event.metaKey || event.ctrlKey
                          )
                        }
                        style={{
                          padding: 4,
                          borderRadius: 4,
                          background: editor.selection.includes(drawer.id)
                            ? 'var(--mantine-color-blue-1)'
                            : undefined
                        }}
                      >
                        <Group justify='space-between' gap='xs' wrap='nowrap'>
                          <Text size='xs'>
                            {drawer.display_number}. {drawer.label}
                          </Text>
                          {severityForEntity(diagnostics, drawer.id) ===
                          'error' ? (
                            <Badge size='xs' color='red'>
                              !
                            </Badge>
                          ) : null}
                        </Group>
                      </UnstyledButton>
                    ))}
                  </Stack>
                </ScrollArea>
                {selected.length > 1 ? (
                  <Stack gap={4}>
                    <Text size='sm' fw={600}>{t`Arrange selection`}</Text>
                    <Group gap={4} wrap='wrap'>
                      {(
                        [
                          'left',
                          'right',
                          'top',
                          'bottom',
                          'horizontal',
                          'vertical'
                        ] as const
                      ).map((mode) => (
                        <Button
                          key={mode}
                          size='compact-xs'
                          variant='default'
                          onClick={() => arrangeSelection(mode)}
                        >
                          {mode === 'horizontal'
                            ? t`Distribute horizontally`
                            : mode === 'vertical'
                              ? t`Distribute vertically`
                              : t`Align ${mode}`}
                        </Button>
                      ))}
                    </Group>
                  </Stack>
                ) : null}
              </Stack>
            </Paper>

            <Stack
              gap='xs'
              style={{ flex: '1 1 520px', minWidth: 300, minHeight: 480 }}
            >
              <Paper withBorder p='xs'>
                <Stack gap='xs'>
                  <Group>
                    <Button
                      variant='light'
                      loading={loadingReference}
                      onClick={() => void loadReference()}
                    >{t`Load / use saved structure`}</Button>
                    {reference && (
                      <Button
                        variant='subtle'
                        onClick={() => {
                          setReference(null);
                          setOpeningId(null);
                        }}
                      >{t`Hide structure reference`}</Button>
                    )}
                  </Group>
                  {reference && (
                    <>
                      <Text size='sm'>{t`Front-view reference: ${reference.envelope.width} × ${reference.envelope.height} mm scaled to logical canvas. Horizontal and vertical scales are independent; this is not a physical unit conversion. Existing drawers are unchanged. Bins use the drawer interior top-down.`}</Text>
                      <Select
                        label={t`Guide placement with opening`}
                        placeholder={t`Free placement`}
                        clearable
                        value={openingId}
                        onChange={setOpeningId}
                        data={openings.map((opening, index) => ({
                          value: opening.id,
                          label: `Opening ${index + 1} (${reference.features.find((f) => f.id === opening.id)?.width} × ${reference.features.find((f) => f.id === opening.id)?.height} mm)`
                        }))}
                      />
                      <Button
                        disabled={!selectedOpening || editor.status !== 'ready'}
                        onClick={() =>
                          selectedOpening &&
                          addDrawer(fitOpening(selectedOpening))
                        }
                      >{t`Add drawer fitted to opening`}</Button>
                      <Text
                        size='xs'
                        c='dimmed'
                      >{t`Cyan dashed areas are openings; solid grey features are dividers/shelves; purple outlines are doors/panels. Selected openings constrain newly drawn drawers only. Move/resize and existing drawers remain independent.`}</Text>
                    </>
                  )}
                </Stack>
              </Paper>
              <EditorCanvas
                bounds={{
                  width: editor.draft.cabinet.width_units,
                  height: editor.draft.cabinet.height_units
                }}
                entities={entities}
                selection={editor.selection}
                grid={grid}
                snap={snap}
                ariaLabel={t`Cabinet front view`}
                onDraw={(rect) => addDrawer(rect)}
                onSelect={editor.toggleSelection}
                onClearSelection={() => editor.setSelection([])}
                onMove={(ids, dx, dy) => onMove(ids, dx, dy)}
                onResize={onResize}
                overlay={
                  <>
                    {reference && (
                      <g data-testid='structure-reference'>
                        <rect
                          x={0}
                          y={0}
                          width={editor.draft.cabinet.width_units}
                          height={editor.draft.cabinet.height_units}
                          fill='none'
                          stroke='#168aad'
                          strokeWidth={3}
                        />
                        {projected.map((feature) => (
                          <rect
                            key={feature.id}
                            x={feature.x}
                            y={feature.y}
                            width={feature.width}
                            height={feature.height}
                            fill={
                              feature.type === 'opening'
                                ? '#22b8cf'
                                : ['partition', 'shelf'].includes(feature.type)
                                  ? '#868e96'
                                  : 'none'
                            }
                            fillOpacity={feature.id === openingId ? 0.3 : 0.12}
                            stroke={
                              feature.type === 'opening'
                                ? '#168aad'
                                : ['door', 'panel'].includes(feature.type)
                                  ? '#7950b2'
                                  : '#495057'
                            }
                            strokeWidth={feature.id === openingId ? 3 : 1.5}
                            strokeDasharray={
                              feature.type === 'opening' ? '6 4' : undefined
                            }
                          />
                        ))}
                      </g>
                    )}
                    <AllocationBands
                      regions={regions}
                      totalPixels={editor.totalPixels}
                    />
                    <CoverageRuler
                      totalPixels={editor.totalPixels}
                      width={editor.draft.cabinet.width_units}
                      y={editor.draft.cabinet.height_units + 20}
                      unused={editor.validation.unused_ranges}
                    />
                  </>
                }
              />
            </Stack>

            <Paper
              withBorder
              p='xs'
              w={280}
              style={{ flex: '0 1 280px', minWidth: 240 }}
            >
              <Button
                variant='subtle'
                size='compact-sm'
                aria-expanded={inspectorOpen}
                onClick={() => setInspectorOpen((open) => !open)}
              >
                {inspectorOpen ? t`Hide properties` : t`Show properties`}
              </Button>
              {inspectorOpen ? (
                <ScrollArea h={520} type='auto'>
                  <Stack gap='sm'>
                    {selectedDrawer ? (
                      <DrawerInspector
                        api={context.api}
                        drawer={selectedDrawer}
                        parentId={editor.cabinet?.location}
                        totalPixels={editor.totalPixels}
                        readOnly={editor.status !== 'ready'}
                        onField={(change) =>
                          editor.apply({
                            type: 'set_field',
                            entity: 'drawer',
                            id: selectedDrawer.id,
                            field: change.field,
                            from: (
                              selectedDrawer as unknown as Record<
                                string,
                                unknown
                              >
                            )[change.field],
                            to: change.value
                          })
                        }
                        onAllocate={(start, end) =>
                          editor.apply({
                            type: 'allocate',
                            id: selectedDrawer.id,
                            from: selectedDrawer.allocation,
                            to:
                              start !== null && end !== null
                                ? { logical_start: start, logical_end: end }
                                : null
                          })
                        }
                        onOpenLocation={openLocation}
                        onEditLocation={(id) => id !== null && openLocation(id)}
                        conflictIds={conflictDiagnostics.map((d) => d.code)}
                      />
                    ) : (
                      <Text size='sm' c='dimmed'>
                        {t`Select a drawer to edit its properties, native binding and logical allocation. Arrow keys move the selection by one grid unit; Shift+arrows use a larger step.`}
                      </Text>
                    )}
                    <ValidationPanel
                      report={editor.validation}
                      onSelectEntity={(ids) => editor.setSelection(ids)}
                    />
                    {selectedDrawer ? (
                      <Button
                        variant='light'
                        onClick={() =>
                          context.navigate(
                            `/plugin/storage-layout/drawers/${selectedDrawer.id}/design`
                          )
                        }
                      >{t`Design drawer interior and bins`}</Button>
                    ) : null}
                    {editor.serverValidation ? (
                      <Alert
                        data-testid='server-diagnostics'
                        variant='light'
                        color={
                          editor.serverValidation.errors.length > 0
                            ? 'red'
                            : 'green'
                        }
                      >
                        {t`Server diagnostics: ${editor.serverValidation.errors.length} error(s), ${editor.serverValidation.warnings.length} warning(s)`}
                      </Alert>
                    ) : null}
                  </Stack>
                </ScrollArea>
              ) : null}
            </Paper>
          </Group>
        </Tabs.Panel>

        <Tabs.Panel value='topology' pt='sm'>
          <TopologyEditor
            client={client}
            cabinetId={cabinetId}
            layoutDirty={editor.dirty}
            onSaved={({ controllers }) => {
              setTopology(topologyFromDocument(controllers));
              void editor.refresh();
            }}
            readOnly={editor.status !== 'ready'}
          />
        </Tabs.Panel>

        <Tabs.Panel value='mapping' pt='sm'>
          <MappingPanel
            client={client}
            cabinetId={cabinetId}
            totalPixels={editor.totalPixels}
            topology={topologyList}
            readOnly={editor.status !== 'ready' || editor.dirty}
            etag={editor.etag}
            onPublished={() => void editor.refresh()}
          />
        </Tabs.Panel>

        <Tabs.Panel value='colors' pt='sm'>
          <FunctionColorsPanel
            client={client}
            cabinetId={cabinetId}
            readOnly={editor.status !== 'ready'}
          />
        </Tabs.Panel>

        <Tabs.Panel value='diagnostics' pt='sm'>
          <SimulationPanel
            active={activeTab === 'diagnostics'}
            client={client}
            cabinetId={cabinetId}
            totalPixels={editor.totalPixels}
            mappingHash={editor.activeMapping?.content_hash ?? null}
            topology={topologyList}
            readOnly={editor.status !== 'ready'}
            defaultTarget={
              selectedDrawer ? { kind: 'drawer', id: selectedDrawer.id } : null
            }
          />
        </Tabs.Panel>
      </Tabs>
      <div style={{ display: activeTab === 'structure' ? 'block' : 'none' }}>
        <StructureEditor
          active={activeTab === 'structure'}
          context={context}
          cabinetId={cabinetId}
          readOnly={editor.status !== 'ready'}
        />
      </div>

      <RenumberModal
        opened={renumberOpen}
        drawers={activeDrawers}
        onClose={() => setRenumberOpen(false)}
        onConfirm={handleRenumber}
      />

      <ArchiveConfirmModal
        opened={archiveOpen}
        title={t`Archive drawer`}
        entityLabel={selected.map((drawer) => drawer.label).join(', ')}
        affected={affectedBins.map((bin) => bin.label)}
        isNew={selectionIds.some(
          (id) => !editor.draft.drawerOrder.includes(id)
        )}
        onClose={() => setArchiveOpen(false)}
        onConfirm={confirmArchive}
      />

      <ConflictModal
        opened={editor.conflict}
        message={editor.error}
        onReload={() => void editor.refresh()}
        onDiscard={editor.revert}
        onClose={() => editor.revert()}
      />

      <Card withBorder padding='xs'>
        <Text size='xs' c='dimmed'>
          {t`Cabinet ${editor.draft.cabinet.width_units}x${editor.draft.cabinet.height_units} units. Grid ${grid}. ${rangeCount(1, editor.totalPixels)} logical pixels.`}
        </Text>
      </Card>
    </Stack>
  );
}
