/**
 * Drawer/bin designer (`drawers/:id/design`).
 *
 * A top-down plan using the drawer's *interior* dimensions (depth, not the
 * front-face height). The bin inspector exposes the inherited drawer LED range
 * as read-only: bins always inherit their drawer's locating behaviour and v1
 * deliberately has no per-bin LED override (design section 7).
 */

import type { InvenTreePluginContext } from '@inventreedb/ui';
import { t } from '@lingui/core/macro';
import {
  Alert,
  Anchor,
  Badge,
  Breadcrumbs,
  Group,
  Paper,
  ScrollArea,
  Stack,
  Tabs,
  Text,
  UnstyledButton
} from '@mantine/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { StorageLayoutClient } from '../api/client';
import {
  type DrawerLayoutResponse,
  layoutActiveMapping,
  StorageLayoutApiError
} from '../api/types';
import {
  type BinDraft,
  type Command,
  type DrawerDraft,
  emptyDraft,
  type LayoutDraft,
  LayoutHistory
} from '../state/commands';
import type { Rect } from '../state/geometry';
import { type GridPreview, gridToBins } from '../state/grid';
import { topologyFromDocument } from '../state/mapping';
import {
  diagnosticsByEntity,
  severityForEntity,
  validateDraft
} from '../state/validation';
import { formatRange, newId, rangeCount } from '../utils';
import { type CanvasEntity, EditorCanvas } from './editor/EditorCanvas';
import { BinInspector } from './editor/Inspector';
import {
  ArchiveConfirmModal,
  ConflictModal,
  GridGeneratorModal
} from './editor/Modals';
import { ValidationPanel } from './editor/Panels';
import { SimulationPanel } from './editor/SimulationPanel';
import { EditorToolbar } from './editor/Toolbar';

export interface DrawerDesignerProps {
  context: InvenTreePluginContext;
  drawerId: string;
}

function binRect(bin: BinDraft): Rect {
  return { x: bin.x, y: bin.y, width: bin.width, height: bin.height };
}

function firstAvailableBinPosition(
  width: number,
  height: number,
  interior: { width: number; height: number },
  bins: BinDraft[],
  grid: number
): { x: number; y: number } | null {
  const xPositions = new Set<number>([0]);
  const yPositions = new Set<number>([0]);
  for (let x = grid; x + width <= interior.width; x += grid) xPositions.add(x);
  for (let y = grid; y + height <= interior.height; y += grid)
    yPositions.add(y);
  xPositions.add(Math.max(0, interior.width - width));
  yPositions.add(Math.max(0, interior.height - height));

  for (const y of [...yPositions].sort((a, b) => a - b)) {
    for (const x of [...xPositions].sort((a, b) => a - b)) {
      const overlaps = bins.some(
        (bin) =>
          x < bin.x + bin.width &&
          x + width > bin.x &&
          y < bin.y + bin.height &&
          y + height > bin.y
      );
      if (!overlaps) return { x, y };
    }
  }
  return null;
}

export function DrawerDesigner({ context, drawerId }: DrawerDesignerProps) {
  const client = useMemo(
    () => new StorageLayoutClient(context.api),
    [context.api]
  );

  const historyRef = useRef<LayoutHistory | null>(null);
  const [, forceRender] = useState(0);
  const rerender = useCallback(() => forceRender((v) => v + 1), []);

  const [status, setStatus] = useState<
    'loading' | 'ready' | 'error' | 'readonly'
  >('loading');
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [selection, setSelection] = useState<string[]>([]);
  const [snap, setSnap] = useState(true);
  const [grid, setGrid] = useState(5);
  const [gridOpen, setGridOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [cabinetId, setCabinetId] = useState<string | null>(null);
  const [etag, setEtag] = useState<string | null>(null);
  const [totalPixels, setTotalPixels] = useState(0);
  const [activeHash, setActiveHash] = useState<string | null>(null);
  const [topology, setTopology] = useState<
    ReturnType<typeof topologyFromDocument>
  >(new Map());

  const load = useCallback(async () => {
    setStatus('loading');
    setError(null);
    try {
      const result = await client.getDrawerLayout(drawerId);
      const response: DrawerLayoutResponse = result.data;
      const draft = emptyDraft({
        // The front rectangle remains in cabinet coordinates. The canvas uses
        // interior dimensions separately; they are not the cabinet's bounds.
        width_units:
          response.cabinet.width_units ??
          response.drawer.x + response.drawer.width,
        height_units:
          response.cabinet.height_units ??
          response.drawer.y + response.drawer.height
      });
      draft.drawers[response.drawer.id ?? drawerId] = {
        ...response.drawer,
        id: response.drawer.id ?? drawerId
      } as DrawerDraft;
      draft.drawerOrder = [response.drawer.id ?? drawerId];
      for (const bin of response.bins) {
        if (!bin.id) continue;
        draft.bins[bin.id] = { ...bin, id: bin.id };
      }
      historyRef.current = new LayoutHistory(draft);
      setEtag(result.etag ?? `"${response.cabinet.revision}"`);
      setCabinetId(response.cabinet.id);
      setTotalPixels(response.cabinet.total_pixels ?? 0);
      setActiveHash(null);
      setDirty(false);
      setStatus('ready');
      client
        .getElectrical(response.cabinet.id)
        .then((electrical) =>
          setTopology(topologyFromDocument(electrical.data.controllers ?? []))
        )
        .catch(() => undefined);
      // The drawer projection omits the mapping hash; read it from the cabinet
      // layout document so the simulation controls can pin the right revision.
      client
        .getLayout(response.cabinet.id)
        .then((layout) =>
          setActiveHash(layoutActiveMapping(layout.data)?.content_hash ?? null)
        )
        .catch(() => undefined);
    } catch (err) {
      const apiError =
        err instanceof StorageLayoutApiError
          ? err
          : new StorageLayoutApiError(String(err), 0);
      if (apiError.isForbidden) {
        setStatus('readonly');
      } else {
        setStatus('error');
        setError(apiError.message);
      }
    }
    rerender();
  }, [client, drawerId, rerender]);

  useEffect(() => {
    void load();
  }, [load]);

  const draft: LayoutDraft =
    historyRef.current?.present ??
    emptyDraft({ width_units: 100, height_units: 100 });

  const drawer = draft.drawers[drawerId] ?? Object.values(draft.drawers)[0];
  const bins = useMemo(() => Object.values(draft.bins), [draft.bins]);
  const activeBins = bins.filter((bin) => !bin.archived);

  const validation = useMemo(() => validateDraft(draft, 0), [draft]);
  const diagnostics = useMemo(
    () => diagnosticsByEntity(validation),
    [validation]
  );

  const apply = useCallback(
    (command: Command, coalesceKey?: string) => {
      if (status !== 'ready' || !historyRef.current) return;
      historyRef.current.apply(command, coalesceKey);
      setDirty(true);
      setConflict(false);
      rerender();
    },
    [status, rerender]
  );

  const undo = useCallback(() => {
    historyRef.current?.undo();
    setDirty(true);
    rerender();
  }, [rerender]);

  const redo = useCallback(() => {
    historyRef.current?.redo();
    setDirty(true);
    rerender();
  }, [rerender]);

  const addBin = useCallback(() => {
    if (!drawer) return;
    const width = Math.min(grid * 4, drawer.interior_width);
    const height = Math.min(grid * 4, drawer.interior_height);
    const position = firstAvailableBinPosition(
      width,
      height,
      { width: drawer.interior_width, height: drawer.interior_height },
      activeBins,
      grid
    );
    if (!position) {
      setError(
        t`No clear space is available for a new bin. Move or resize an existing bin first.`
      );
      return;
    }
    const bin: BinDraft = {
      id: newId(),
      is_new: true,
      drawer: drawer.id,
      label: `B${activeBins.length + 1}`,
      location: null,
      ...position,
      width,
      height,
      archived: false
    };
    apply({ type: 'add_bin', bin });
    setSelection([bin.id]);
  }, [activeBins, apply, drawer, grid]);

  const drawBin = useCallback(
    (rect: { x: number; y: number; width: number; height: number }) => {
      if (!drawer || status !== 'ready') return;
      const bin: BinDraft = {
        id: newId(),
        is_new: true,
        drawer: drawer.id,
        label: `B${activeBins.length + 1}`,
        location: null,
        ...rect,
        archived: false
      };
      apply({ type: 'add_bin', bin });
      setSelection([bin.id]);
    },
    [activeBins.length, apply, drawer, status]
  );

  const duplicateSelection = useCallback(() => {
    if (!drawer) return;
    const commands: Command[] = [];
    const ids: string[] = [];
    for (const id of selection) {
      const bin = draft.bins[id];
      if (!bin) continue;
      const copy: BinDraft = {
        ...bin,
        id: newId(),
        is_new: true,
        label: `${bin.label} copy`,
        // A duplicated bin never reuses a native location binding.
        location: null,
        x: Math.min(bin.x + grid, drawer.interior_width - bin.width),
        y: Math.min(bin.y + grid, drawer.interior_height - bin.height)
      };
      commands.push({ type: 'add_bin', bin: copy });
      ids.push(copy.id);
    }
    if (commands.length) {
      apply(commands.length === 1 ? commands[0] : { type: 'batch', commands });
      setSelection(ids);
    }
  }, [apply, draft.bins, drawer, grid, selection]);

  const onMove = useCallback(
    (ids: string[], dx: number, dy: number) => {
      const deltas: Record<string, { dx: number; dy: number }> = {};
      for (const id of ids) deltas[id] = { dx, dy };
      apply({ type: 'move', entity: 'bin', deltas });
    },
    [apply]
  );

  const onResize = useCallback(
    (id: string, rect: Rect) => {
      const bin = draft.bins[id];
      if (!bin) return;
      apply({
        type: 'resize',
        entity: 'bin',
        id,
        from: binRect(bin),
        to: rect
      });
    },
    [apply, draft.bins]
  );

  const confirmGrid = useCallback(
    (preview: GridPreview, prefix: string) => {
      if (!drawer) return;
      const newBins = gridToBins(preview, {
        drawerId: drawer.id,
        labelPrefix: `${prefix}-`,
        newId
      });
      const commands: Command[] = newBins.map((bin) => ({
        type: 'add_bin',
        bin
      }));
      if (commands.length) apply({ type: 'batch', commands });
      setGridOpen(false);
    },
    [apply, drawer]
  );

  const confirmArchive = useCallback(() => {
    const commands: Command[] = [];
    for (const id of selection) {
      const bin = draft.bins[id];
      if (!bin) continue;
      commands.push({ type: 'remove_bin', bin });
    }
    if (commands.length) {
      apply(commands.length === 1 ? commands[0] : { type: 'batch', commands });
    }
    setSelection([]);
    setArchiveOpen(false);
  }, [apply, draft.bins, selection]);

  const save = useCallback(async () => {
    if (!drawer || !historyRef.current || saving) return;
    const submittedDraft = historyRef.current.present;
    setSaving(true);
    setError(null);
    try {
      const document = {
        schema_version: 1,
        drawer: { ...drawer },
        bins: Object.values(submittedDraft.bins).map(({ id, ...rest }) => ({
          id,
          ...rest
        })),
        archive_ids: [...submittedDraft.archiveIds]
      };
      const result = await client.saveDrawerLayout(drawerId, document, etag);
      setEtag(result.etag ?? etag);
      setTotalPixels(result.data.cabinet.total_pixels ?? 0);
      setConflict(false);
      if (historyRef.current.present === submittedDraft) {
        const savedDraft = emptyDraft({
          width_units:
            result.data.cabinet.width_units ??
            submittedDraft.cabinet.width_units,
          height_units:
            result.data.cabinet.height_units ??
            submittedDraft.cabinet.height_units
        });
        savedDraft.drawers[result.data.drawer.id ?? drawerId] = {
          ...result.data.drawer,
          id: result.data.drawer.id ?? drawerId
        } as DrawerDraft;
        savedDraft.drawerOrder = [result.data.drawer.id ?? drawerId];
        for (const bin of result.data.bins) {
          if (bin.id) savedDraft.bins[bin.id] = { ...bin, id: bin.id };
        }
        savedDraft.archiveIds = [...(result.data.archive_ids ?? [])];
        historyRef.current.reset(savedDraft);
        setDirty(false);
      } else {
        setDirty(true);
      }
      setError(t`Drawer layout saved.`);
      rerender();
    } catch (err) {
      const apiError =
        err instanceof StorageLayoutApiError
          ? err
          : new StorageLayoutApiError(String(err), 0);
      if (apiError.isStale) {
        setConflict(true);
      } else {
        setError(apiError.message);
      }
    } finally {
      setSaving(false);
    }
  }, [client, drawer, drawerId, etag, rerender, saving]);

  const entities = useMemo<CanvasEntity[]>(
    () =>
      bins.map((bin) => ({
        id: bin.id,
        label: bin.label,
        rect: binRect(bin),
        archived: bin.archived,
        severity: severityForEntity(diagnostics, bin.id),
        detail: bin.location ? t`loc ${bin.location}` : t`unbound`
      })),
    [bins, diagnostics]
  );

  if (status === 'loading') return <Text p='md'>{t`Loading drawer…`}</Text>;
  if (status === 'error') {
    return (
      <Alert m='md' color='red' title={t`Unable to load drawer`}>
        {error}
      </Alert>
    );
  }
  if (!drawer) {
    return (
      <Alert m='md' color='yellow'>
        {t`Drawer not found.`}
      </Alert>
    );
  }

  const selectedBin = selection.length === 1 ? draft.bins[selection[0]] : null;
  const inheritedRange = drawer.allocation;

  return (
    <Stack gap='sm' p='sm' data-testid='drawer-designer'>
      <Breadcrumbs>
        <Anchor
          onClick={() =>
            cabinetId &&
            context.navigate(
              `/plugin/storage-layout/cabinets/${cabinetId}/design`
            )
          }
        >
          {cabinetId ? t`Cabinet ${cabinetId.slice(0, 8)}` : t`Cabinet`}
        </Anchor>
        <Text>{drawer.label}</Text>
      </Breadcrumbs>

      <Group gap='xs'>
        <Text fw={700}>{t`Drawer ${drawer.label}`}</Text>
        <Badge variant='light'>
          {t`interior ${drawer.interior_width}x${drawer.interior_height}`}
        </Badge>
        {drawer.allocation ? (
          <Badge color='green' variant='light'>
            {t`LEDs ${formatRange(drawer.allocation.logical_start, drawer.allocation.logical_end)} (${rangeCount(drawer.allocation.logical_start, drawer.allocation.logical_end)})`}
          </Badge>
        ) : (
          <Badge color='gray' variant='light'>
            {t`unlit`}
          </Badge>
        )}
        {dirty ? <Badge color='orange'>{t`Unsaved`}</Badge> : null}
      </Group>

      <EditorToolbar
        readOnly={status !== 'ready'}
        dirty={dirty}
        saving={saving}
        canUndo={historyRef.current?.canUndo ?? false}
        canRedo={historyRef.current?.canRedo ?? false}
        snap={snap}
        grid={grid}
        onToggleSnap={setSnap}
        onGridChange={setGrid}
        onAdd={addBin}
        addLabel={t`Add bin`}
        onDuplicate={duplicateSelection}
        duplicateDisabled={selection.length === 0}
        onArchive={() => setArchiveOpen(true)}
        archiveLabel={t`Delete bin`}
        archiveDisabled={selection.length === 0}
        onUndo={undo}
        onRedo={redo}
        onSave={() => void save()}
        onRevert={() => {
          void load();
        }}
        extra={
          <UnstyledButton
            onClick={() => setGridOpen(true)}
            aria-label={t`Generate bin grid`}
          >
            <Badge variant='light'>{t`Grid generator`}</Badge>
          </UnstyledButton>
        }
      />

      {error ? (
        <Alert color='blue' withCloseButton onClose={() => setError(null)}>
          {error}
        </Alert>
      ) : null}

      <Tabs defaultValue='layout'>
        <Tabs.List>
          <Tabs.Tab value='layout'>{t`Layout`}</Tabs.Tab>
          <Tabs.Tab value='diagnostics'>{t`Diagnostics`}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value='layout' pt='sm'>
          <Group align='flex-start' gap='sm' wrap='nowrap'>
            <Paper withBorder p='xs' w={200} style={{ flexShrink: 0 }}>
              <Stack gap={2} data-testid='bin-list'>
                <Text size='sm' fw={600}>
                  {t`Bins`}
                </Text>
                <ScrollArea h={420} type='auto'>
                  {activeBins.map((bin) => (
                    <UnstyledButton
                      key={bin.id}
                      aria-label={t`Bin ${bin.label}`}
                      aria-selected={selection.includes(bin.id)}
                      onClick={(event) =>
                        setSelection(
                          event.shiftKey || event.metaKey || event.ctrlKey
                            ? selection.includes(bin.id)
                              ? selection.filter((value) => value !== bin.id)
                              : [...selection, bin.id]
                            : [bin.id]
                        )
                      }
                      style={{
                        display: 'block',
                        padding: 4,
                        width: '100%',
                        textAlign: 'left',
                        borderRadius: 4,
                        background: selection.includes(bin.id)
                          ? 'var(--mantine-color-blue-1)'
                          : undefined
                      }}
                    >
                      <Text size='xs'>{bin.label}</Text>
                    </UnstyledButton>
                  ))}
                </ScrollArea>
              </Stack>
            </Paper>

            <Stack gap='xs' style={{ flex: 1, minWidth: 320 }}>
              <EditorCanvas
                bounds={{
                  width: drawer.interior_width,
                  height: drawer.interior_height
                }}
                entities={entities}
                selection={selection}
                grid={grid}
                snap={snap}
                ariaLabel={t`Drawer top-down view`}
                onSelect={(id, additive) =>
                  setSelection(
                    additive
                      ? selection.includes(id)
                        ? selection.filter((value) => value !== id)
                        : [...selection, id]
                      : [id]
                  )
                }
                onClearSelection={() => setSelection([])}
                onMove={onMove}
                onResize={onResize}
                onDraw={drawBin}
              />
            </Stack>

            <Paper withBorder p='xs' w={280} style={{ flexShrink: 0 }}>
              <ScrollArea h={520} type='auto'>
                <Stack gap='sm'>
                  {selectedBin ? (
                    <BinInspector
                      api={context.api}
                      bin={selectedBin}
                      parentId={drawer?.location}
                      inheritedRange={inheritedRange}
                      readOnly={status !== 'ready'}
                      onField={(change) =>
                        apply({
                          type: 'set_field',
                          entity: 'bin',
                          id: selectedBin.id,
                          field: change.field,
                          from: (
                            selectedBin as unknown as Record<string, unknown>
                          )[change.field],
                          to: change.value
                        })
                      }
                      onOpenLocation={(locationId) =>
                        context.navigate(`/stock/location/${locationId}`)
                      }
                      onEditLocation={(locationId) =>
                        locationId !== null &&
                        context.navigate(`/stock/location/${locationId}`)
                      }
                    />
                  ) : (
                    <Text size='sm' c='dimmed'>
                      {t`Select a bin to edit its rectangle and native binding. Bins inherit the drawer's LED range.`}
                    </Text>
                  )}
                  <ValidationPanel
                    report={validation}
                    onSelectEntity={(ids) => setSelection(ids)}
                  />
                </Stack>
              </ScrollArea>
            </Paper>
          </Group>
        </Tabs.Panel>

        <Tabs.Panel value='diagnostics' pt='sm'>
          <SimulationPanel
            client={client}
            cabinetId={cabinetId ?? ''}
            totalPixels={totalPixels}
            mappingHash={activeHash}
            topology={[...topology.values()]}
            readOnly={status !== 'ready'}
            defaultTarget={
              selectedBin?.location
                ? { kind: 'location', id: String(selectedBin.location) }
                : drawer.location
                  ? { kind: 'location', id: String(drawer.location) }
                  : null
            }
          />
        </Tabs.Panel>
      </Tabs>

      <GridGeneratorModal
        opened={gridOpen}
        interior={{
          width: drawer.interior_width,
          height: drawer.interior_height
        }}
        existing={activeBins}
        onClose={() => setGridOpen(false)}
        onConfirm={confirmGrid}
      />

      <ArchiveConfirmModal
        opened={archiveOpen}
        title={t`Delete bin overlay`}
        entityLabel={selection
          .map((id) => draft.bins[id]?.label)
          .filter(Boolean)
          .join(', ')}
        affected={[]}
        isNew
        onClose={() => setArchiveOpen(false)}
        onConfirm={confirmArchive}
      />

      <ConflictModal
        opened={conflict}
        message={t`The cabinet revision changed. Reload before saving.`}
        onReload={() => void load()}
        onDiscard={() => void load()}
        onClose={() => setConflict(false)}
      />
    </Stack>
  );
}
