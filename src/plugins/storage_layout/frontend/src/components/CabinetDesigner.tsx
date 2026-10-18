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
  Card,
  Group,
  Paper,
  ScrollArea,
  Stack,
  Tabs,
  Text,
  UnstyledButton
} from '@mantine/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { StorageLayoutClient } from '../api/client';
import type { Diagnostic } from '../api/types';
import {
  type Command,
  type DrawerDraft,
  layoutFromDraft
} from '../state/commands';
import { findFreeDrawerPosition, type Rect } from '../state/geometry';
import { useDirtyUnloadGuard, useLayoutEditor } from '../state/layoutDraft';
import { topologyFromDocument } from '../state/mapping';
import { diagnosticsByEntity, severityForEntity } from '../state/validation';
import { formatRange, newId, rangeCount } from '../utils';
import { type CanvasEntity, EditorCanvas } from './editor/EditorCanvas';
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

  const [snap, setSnap] = useState(true);
  const [grid, setGrid] = useState(10);
  const [renumberOpen, setRenumberOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [serverMessage, setServerMessage] = useState<string | null>(null);
  const [topology, setTopology] = useState<
    ReturnType<typeof topologyFromDocument>
  >(new Map());

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
      const deltas: Record<string, { dx: number; dy: number }> = {};
      for (const id of ids) deltas[id] = { dx, dy };
      editor.apply({ type: 'move', entity: 'drawer', deltas });
    },
    [editor]
  );

  const onResize = useCallback(
    (id: string, rect: Rect) => {
      const drawer = editor.draft.drawers[id];
      if (!drawer) return;
      editor.apply({
        type: 'resize',
        entity: 'drawer',
        id,
        from: drawerRect(drawer),
        to: rect
      });
    },
    [editor]
  );

  const addDrawer = useCallback(() => {
    const bounds = {
      width: editor.draft.cabinet.width_units,
      height: editor.draft.cabinet.height_units
    };
    const size = {
      width: Math.min(grid * 6, bounds.width),
      height: Math.min(grid * 4, bounds.height)
    };
    const position = findFreeDrawerPosition(
      bounds,
      size,
      activeDrawers.map(drawerRect),
      grid
    );
    if (!position) {
      setServerMessage(t`Insufficient free space to add a drawer.`);
      return;
    }
    setServerMessage(null);
    const display_numbers = activeDrawers.map(
      (drawer) => drawer.display_number
    );
    const next = display_numbers.length ? Math.max(...display_numbers) + 1 : 1;
    const drawer: DrawerDraft = {
      id: newId(),
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
  }, [activeDrawers, editor, grid]);

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
    setArchiveOpen(true);
  }, []);

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
      if (typing) return;

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
  }, [archiveSelection, duplicateSelection, editor, selectionIds.length]);

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
        onAdd={addDrawer}
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
        <Alert color='red'>{editor.error}</Alert>
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

      <Tabs defaultValue='layout'>
        <Tabs.List>
          <Tabs.Tab value='layout'>{t`Layout`}</Tabs.Tab>
          <Tabs.Tab value='topology'>{t`Topology`}</Tabs.Tab>
          <Tabs.Tab value='mapping'>{t`Mapping`}</Tabs.Tab>
          <Tabs.Tab value='diagnostics'>{t`Diagnostics`}</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value='layout' pt='sm'>
          <Group align='flex-start' gap='sm' wrap='nowrap'>
            <Paper withBorder p='xs' w={200} style={{ flexShrink: 0 }}>
              <Stack gap='xs'>
                <Text size='sm' fw={600}>
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
              </Stack>
            </Paper>

            <Stack gap='xs' style={{ flex: 1, minWidth: 320 }}>
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
                onSelect={editor.toggleSelection}
                onClearSelection={() => editor.setSelection([])}
                onMove={(ids, dx, dy) => onMove(ids, dx, dy)}
                onResize={onResize}
                overlay={
                  <>
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

            <Paper withBorder p='xs' w={280} style={{ flexShrink: 0 }}>
              <ScrollArea h={520} type='auto'>
                <Stack gap='sm'>
                  {selectedDrawer ? (
                    <DrawerInspector
                      drawer={selectedDrawer}
                      totalPixels={editor.totalPixels}
                      readOnly={editor.status !== 'ready'}
                      onField={(change) =>
                        editor.apply({
                          type: 'set_field',
                          entity: 'drawer',
                          id: selectedDrawer.id,
                          field: change.field,
                          from: (
                            selectedDrawer as unknown as Record<string, unknown>
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
            </Paper>
          </Group>
        </Tabs.Panel>

        <Tabs.Panel value='topology' pt='sm'>
          <TopologyEditor
            client={client}
            cabinetId={cabinetId}
            readOnly={editor.status !== 'ready'}
          />
        </Tabs.Panel>

        <Tabs.Panel value='mapping' pt='sm'>
          <MappingPanel
            client={client}
            cabinetId={cabinetId}
            totalPixels={editor.totalPixels}
            topology={[...topology.values()]}
            readOnly={editor.status !== 'ready'}
            etag={editor.etag}
            onPublished={() => void editor.refresh()}
          />
        </Tabs.Panel>

        <Tabs.Panel value='diagnostics' pt='sm'>
          <SimulationPanel
            client={client}
            cabinetId={cabinetId}
            totalPixels={editor.totalPixels}
            mappingHash={editor.activeMapping?.content_hash ?? null}
            topology={[...topology.values()]}
            readOnly={editor.status !== 'ready'}
            defaultTarget={
              selectedDrawer ? { kind: 'drawer', id: selectedDrawer.id } : null
            }
          />
        </Tabs.Panel>
      </Tabs>

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
