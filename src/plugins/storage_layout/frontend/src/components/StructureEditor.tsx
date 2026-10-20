import type { InvenTreePluginContext } from '@inventreedb/ui';
import { t } from '@lingui/core/macro';
import {
  Alert,
  Button,
  Group,
  NumberInput,
  Paper,
  Select,
  Stack,
  Text
} from '@mantine/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StorageLayoutClient } from '../api/client';

export type StructureFeatureType =
  | 'partition'
  | 'shelf'
  | 'opening'
  | 'door'
  | 'panel';
export interface StructureFeature {
  id: string;
  type: StructureFeatureType;
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface StructureDocument {
  schema_version: 1;
  units: 'mm';
  view: 'front';
  envelope: { width: number; height: number; depth: number };
  features: StructureFeature[];
}
const TYPES: StructureFeatureType[] = [
  'partition',
  'shelf',
  'opening',
  'door',
  'panel'
];
const makeId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `feature-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const validationErrors = (s: StructureDocument): string[] => {
  const errors: string[] = [];
  if (
    ![s.envelope.width, s.envelope.height, s.envelope.depth].every(
      Number.isFinite
    ) ||
    s.envelope.width <= 0 ||
    s.envelope.height <= 0 ||
    s.envelope.depth <= 0
  ) {
    errors.push('Cabinet envelope dimensions must be positive finite numbers.');
  }
  const openings: StructureFeature[] = [];
  for (const feature of s.features) {
    if (
      ![feature.x, feature.y, feature.width, feature.height].every(
        Number.isFinite
      )
    ) {
      errors.push(`${feature.type} dimensions must be finite numbers.`);
      continue;
    }
    if (
      feature.x < 0 ||
      feature.y < 0 ||
      feature.width <= 0 ||
      feature.height <= 0
    ) {
      errors.push(
        `${feature.type} coordinates must be nonnegative and dimensions positive.`
      );
    }
    if (
      feature.x + feature.width > s.envelope.width ||
      feature.y + feature.height > s.envelope.height
    ) {
      errors.push(`${feature.type} lies outside the cabinet envelope.`);
    }
    if (feature.type === 'opening') {
      if (
        openings.some(
          (other) =>
            feature.x < other.x + other.width &&
            other.x < feature.x + feature.width &&
            feature.y < other.y + other.height &&
            other.y < feature.y + feature.height
        )
      ) {
        errors.push('Openings must not overlap.');
      }
      openings.push(feature);
    }
  }
  return errors;
};
const valid = (s: StructureDocument) => validationErrors(s).length === 0;
type Drag =
  | {
      kind: 'draw';
      type: StructureFeatureType;
      startX: number;
      startY: number;
      pointerX: number;
      pointerY: number;
    }
  | {
      kind: 'move' | 'resize' | 'envelope';
      startX: number;
      startY: number;
      feature: StructureFeature | null;
      original: StructureDocument;
    }
  | {
      kind: 'pan';
      startX: number;
      startY: number;
      offsetX: number;
      offsetY: number;
    };

export function StructureEditor({
  context,
  cabinetId,
  readOnly = false
}: {
  context: InvenTreePluginContext;
  cabinetId: string;
  readOnly?: boolean;
}) {
  const client = useMemo(
    () => new StorageLayoutClient(context.api),
    [context.api]
  );
  const [document, setDocument] = useState<StructureDocument | null>(null);
  const [saved, setSaved] = useState<StructureDocument | null>(null);
  const [revision, setRevision] = useState<number | null>(null);
  const [selection, setSelection] = useState<string | null>(null);
  const [tool, setTool] = useState<
    'select' | 'pan' | 'cabinet' | StructureFeatureType
  >('select');
  const [snap, setSnap] = useState(true);
  const [grid, setGrid] = useState(10);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [past, setPast] = useState<StructureDocument[]>([]);
  const [future, setFuture] = useState<StructureDocument[]>([]);
  const drag = useRef<Drag | null>(null);
  const initial = useRef({ width: 600, height: 800, depth: 400 });
  const dirty = JSON.stringify(document) !== JSON.stringify(saved);

  useEffect(() => {
    let alive = true;
    client
      .getCabinet(cabinetId)
      .then(({ data }) => {
        if (!alive) return;
        const d =
          (data as typeof data & { structure?: StructureDocument | null })
            .structure ?? null;
        setDocument(d);
        setSaved(d);
        setRevision(data.revision);
      })
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [client, cabinetId]);

  const commit = useCallback(
    (next: StructureDocument) => {
      if (document) setPast((items) => [...items.slice(-49), document]);
      setDocument(next);
      setFuture([]);
    },
    [document]
  );
  const snapValue = (value: number) => {
    const step = snap ? grid : 1;
    return Math.max(0, Math.round(value / step) * step);
  };
  const update = (id: string, values: Partial<StructureFeature>) => {
    if (document)
      commit({
        ...document,
        features: document.features.map((f) =>
          f.id === id ? { ...f, ...values } : f
        )
      });
  };
  const undo = useCallback(() => {
    const previous = past.at(-1);
    if (!previous || !document) return;
    setPast((items) => items.slice(0, -1));
    setFuture((items) => [document, ...items]);
    setDocument(previous);
  }, [document, past]);
  const redo = useCallback(() => {
    const next = future[0];
    if (!next || !document) return;
    setFuture((items) => items.slice(1));
    setPast((items) => [...items, document]);
    setDocument(next);
  }, [document, future]);
  const remove = () => {
    if (
      !document ||
      !selection ||
      !window.confirm('Delete selected structure feature?')
    )
      return;
    commit({
      ...document,
      features: document.features.filter((f) => f.id !== selection)
    });
    setSelection(null);
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        const active = drag.current;
        if (active && 'original' in active) setDocument(active.original);
        drag.current = null;
        setTool('select');
      }
      if (
        (event.key === 'Delete' || event.key === 'Backspace') &&
        selection &&
        document &&
        !readOnly &&
        !/INPUT|TEXTAREA/.test((event.target as HTMLElement)?.tagName ?? '')
      ) {
        event.preventDefault();
        if (window.confirm('Delete selected structure feature?')) {
          commit({
            ...document,
            features: document.features.filter((f) => f.id !== selection)
          });
          setSelection(null);
        }
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [commit, document, readOnly, redo, selection, undo]);

  const point = (event: React.PointerEvent<SVGElement>) => {
    const bounds =
      event.currentTarget.ownerSVGElement?.getBoundingClientRect() ??
      event.currentTarget.getBoundingClientRect();
    return {
      x: (event.clientX - bounds.left - 30 - pan.x) / zoom,
      y: (event.clientY - bounds.top - 20 - pan.y) / zoom
    };
  };
  const beginDrawing = (event: React.PointerEvent<SVGRectElement>) => {
    if (!document || readOnly) return;
    if (tool === 'pan') {
      drag.current = {
        kind: 'pan',
        startX: event.clientX,
        startY: event.clientY,
        offsetX: pan.x,
        offsetY: pan.y
      };
    } else if (tool === 'cabinet') {
      drag.current = {
        kind: 'envelope',
        startX: event.clientX,
        startY: event.clientY,
        feature: null,
        original: document
      };
    } else if (tool !== 'select') {
      const p = point(event);
      drag.current = {
        kind: 'draw',
        type: tool,
        startX: snapValue(p.x),
        startY: snapValue(p.y),
        pointerX: p.x,
        pointerY: p.y
      };
    }
    if (drag.current) event.currentTarget.setPointerCapture(event.pointerId);
  };
  const movePointer = (event: React.PointerEvent<SVGElement>) => {
    const active = drag.current;
    if (!active || !document) return;
    if (active.kind === 'pan') {
      setPan({
        x: active.offsetX + event.clientX - active.startX,
        y: active.offsetY + event.clientY - active.startY
      });
      return;
    }
    const p = point(event);
    const dx = (event.clientX - active.startX) / zoom;
    const dy = (event.clientY - active.startY) / zoom;
    if (active.kind === 'draw') {
      drag.current = { ...active, pointerX: p.x, pointerY: p.y };
      return;
    }
    const original = active.original;
    if (active.kind === 'envelope') {
      const width = Math.max(10, snapValue(original.envelope.width + dx));
      const height = Math.max(10, snapValue(original.envelope.height + dy));
      setDocument({
        ...original,
        envelope: { ...original.envelope, width, height }
      });
      return;
    }
    if (!active.feature) return;
    const f = active.feature;
    const x = snapValue(f.x + dx),
      y = snapValue(f.y + dy);
    const next =
      active.kind === 'resize'
        ? {
            ...f,
            width: Math.max(1, snapValue(f.width + dx)),
            height: Math.max(1, snapValue(f.height + dy))
          }
        : {
            ...f,
            x: Math.min(original.envelope.width - f.width, x),
            y: Math.min(original.envelope.height - f.height, y)
          };
    setDocument({
      ...original,
      features: original.features.map((item) =>
        item.id === f.id ? next : item
      )
    });
  };
  const endPointer = () => {
    const active = drag.current;
    drag.current = null;
    if (!active || !document || active.kind === 'pan') return;
    if (active.kind === 'draw') {
      const x2 = snapValue(active.pointerX),
        y2 = snapValue(active.pointerY);
      const x = Math.min(active.startX, x2),
        y = Math.min(active.startY, y2);
      const width = Math.min(
        document.envelope.width - x,
        Math.max(10, Math.abs(x2 - active.startX))
      );
      const height = Math.min(
        document.envelope.height - y,
        Math.max(10, Math.abs(y2 - active.startY))
      );
      if (width <= 0 || height <= 0) return;
      const feature = { id: makeId(), type: active.type, x, y, width, height };
      commit({ ...document, features: [...document.features, feature] });
      setSelection(feature.id);
      setTool('select');
    } else {
      setPast((items) => [...items.slice(-49), active.original]);
      setFuture([]);
    }
  };
  const errors = document ? validationErrors(document) : [];
  const save = async () => {
    if (!document || revision === null || errors.length > 0) return;
    setSaving(true);
    setError('');
    try {
      const response = await client.updateStructure(
        cabinetId,
        document,
        revision
      );
      const result =
        (response as typeof response & { structure?: StructureDocument })
          .structure ?? document;
      setDocument(result);
      setSaved(result);
      setRevision(response.revision);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };
  if (!document)
    return (
      <Stack p='md'>
        <Alert
          title={t`Physical structure is not initialized`}
        >{t`Legacy width_units and height_units are logical units, not millimetres. They will not be converted.`}</Alert>
        <Text>{t`Initialize a separate front-view structure document in millimetres. This does not alter drawers, bins, locations or mappings.`}</Text>
        <Group>
          {(['width', 'height', 'depth'] as const).map((key) => (
            <NumberInput
              key={key}
              label={`${key[0].toUpperCase()}${key.slice(1)} (mm)`}
              min={1}
              value={initial.current[key]}
              onChange={(value) => {
                initial.current[key] = Number(value) || 0;
              }}
            />
          ))}
          <Button
            disabled={readOnly}
            onClick={() => {
              const next: StructureDocument = {
                schema_version: 1,
                units: 'mm',
                view: 'front',
                envelope: { ...initial.current },
                features: []
              };
              if (valid(next)) {
                setDocument(next);
                setSaved(null);
                setPast([]);
              }
            }}
          >{t`Initialize structure`}</Button>
        </Group>
      </Stack>
    );
  const selected = document.features.find(
    (feature) => feature.id === selection
  );
  const scale = zoom;
  return (
    <Stack gap='sm' p='sm'>
      <Group>
        <Text fw={700}>{t`Cabinet / Structure — front view (mm)`}</Text>
        <Select
          aria-label='Tool'
          value={tool}
          data={[
            'select',
            'cabinet',
            'partition',
            'shelf',
            'opening',
            'door',
            'panel',
            'pan'
          ].map((value) => ({
            value,
            label: value === 'cabinet' ? 'Draw Cabinet' : value
          }))}
          onChange={(value) => value && setTool(value as typeof tool)}
          w={160}
        />
        <Button
          onClick={() => setTool('cabinet')}
          disabled={readOnly}
        >{t`Draw Cabinet`}</Button>
        {TYPES.map((type) => (
          <Button
            key={type}
            title={`Drag to draw ${type}`}
            variant={tool === type ? 'filled' : 'default'}
            onClick={() => setTool(type)}
            disabled={readOnly}
          >
            {type[0].toUpperCase() + type.slice(1)}
          </Button>
        ))}
        <Button onClick={undo} disabled={!past.length}>{t`Undo`}</Button>
        <Button onClick={redo} disabled={!future.length}>{t`Redo`}</Button>
        <Button
          onClick={() => {
            setZoom(1);
            setPan({ x: 0, y: 0 });
          }}
        >{t`Fit`}</Button>
        <Button
          aria-label='Zoom in'
          onClick={() => setZoom((value) => Math.min(3, value + 0.1))}
        >
          +
        </Button>
        <Button
          aria-label='Zoom out'
          onClick={() => setZoom((value) => Math.max(0.3, value - 0.1))}
        >
          −
        </Button>
        <Button onClick={() => setSnap((value) => !value)}>
          {snap ? t`Snap on` : t`Snap off`}
        </Button>
        <NumberInput
          label={t`Grid (mm)`}
          value={grid}
          min={1}
          onChange={(value) => setGrid(Number(value) || 1)}
          w={90}
        />
        <Button
          color='red'
          onClick={remove}
          disabled={!selected || readOnly}
        >{t`Delete`}</Button>
        <Button
          loading={saving}
          data-testid='save-structure-button'
          disabled={!dirty || readOnly || !valid(document)}
          onClick={() => void save()}
        >{t`Save structure`}</Button>
      </Group>
      {tool !== 'select' && (
        <Text size='sm' c='dimmed'>
          {tool === 'pan'
            ? t`Drag the canvas to pan.`
            : tool === 'cabinet'
              ? t`Drag the cabinet corner to set its outer width and height.`
              : t`Drag on the cabinet to draw a ${tool}. Press Escape to cancel.`}
        </Text>
      )}
      {error && (
        <Alert color='red' title={t`Structure error`}>
          {error}
        </Alert>
      )}
      {errors.length > 0 && (
        <Alert color='red' title={t`Structure validation errors`}>
          {errors.map((message) => (
            <div key={message}>{message}</div>
          ))}
        </Alert>
      )}
      {dirty && (
        <Text
          c='orange'
          data-testid='structure-dirty'
        >{t`Unsaved structure changes`}</Text>
      )}
      <Group align='start' wrap='nowrap'>
        <Paper withBorder p='sm' style={{ overflow: 'auto', flex: 1 }}>
          <svg
            role='img'
            aria-label='Cabinet structure drawing'
            width={Math.max(500, document.envelope.width * scale + 60)}
            height={Math.max(500, document.envelope.height * scale + 60)}
            onWheel={(event) => {
              if (event.ctrlKey)
                setZoom((value) =>
                  Math.max(
                    0.3,
                    Math.min(3, value + (event.deltaY < 0 ? 0.1 : -0.1))
                  )
                );
            }}
            onPointerMove={movePointer}
            onPointerUp={endPointer}
            onPointerCancel={endPointer}
          >
            <defs>
              <pattern
                id='structure-grid'
                width={grid * scale}
                height={grid * scale}
                patternUnits='userSpaceOnUse'
              >
                <path
                  d={`M ${grid * scale} 0 L 0 0 0 ${grid * scale}`}
                  fill='none'
                  stroke='#ddd'
                  strokeWidth='.7'
                />
              </pattern>
            </defs>
            <g
              transform={`translate(${30 + pan.x},${20 + pan.y}) scale(${scale})`}
            >
              <rect
                data-testid='cabinet-envelope'
                width={document.envelope.width}
                height={document.envelope.height}
                fill='url(#structure-grid)'
                stroke='#222'
                strokeWidth={3 / scale}
                onPointerDown={beginDrawing}
              />
              {document.features.map((feature) => (
                <g key={feature.id}>
                  <rect
                    data-testid={`feature-${feature.type}`}
                    aria-label={`${feature.type} feature`}
                    x={feature.x}
                    y={feature.y}
                    width={feature.width}
                    height={feature.height}
                    fill={
                      feature.type === 'opening'
                        ? '#fff'
                        : feature.type === 'door'
                          ? '#e4c49c'
                          : feature.type === 'panel'
                            ? '#aaa'
                            : '#8ab6d6'
                    }
                    fillOpacity={feature.type === 'opening' ? 1 : 0.8}
                    stroke={selection === feature.id ? '#e33' : '#174a69'}
                    strokeWidth={
                      selection === feature.id ? 3 / scale : 1.5 / scale
                    }
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      setSelection(feature.id);
                      if (tool === 'pan') {
                        beginDrawing(
                          event as unknown as React.PointerEvent<SVGRectElement>
                        );
                        return;
                      }
                      if (!readOnly && tool === 'select') {
                        drag.current = {
                          kind: 'move',
                          startX: event.clientX,
                          startY: event.clientY,
                          feature,
                          original: document
                        };
                        event.currentTarget.setPointerCapture(event.pointerId);
                      }
                    }}
                  />
                  {selection === feature.id && (
                    <rect
                      data-testid='feature-resize-handle'
                      aria-label='Resize feature'
                      x={feature.x + feature.width - 4 / scale}
                      y={feature.y + feature.height - 4 / scale}
                      width={10 / scale}
                      height={10 / scale}
                      fill='#e33'
                      onPointerDown={(event) => {
                        event.stopPropagation();
                        drag.current = {
                          kind: 'resize',
                          startX: event.clientX,
                          startY: event.clientY,
                          feature,
                          original: document
                        };
                        event.currentTarget.setPointerCapture(event.pointerId);
                      }}
                    />
                  )}
                </g>
              ))}
              <rect
                data-testid='cabinet-resize-handle'
                aria-label='Resize cabinet envelope'
                x={document.envelope.width - 6 / scale}
                y={document.envelope.height - 6 / scale}
                width={12 / scale}
                height={12 / scale}
                fill='#222'
                onPointerDown={(event) => {
                  if (readOnly) return;
                  event.stopPropagation();
                  drag.current = {
                    kind: 'envelope',
                    startX: event.clientX,
                    startY: event.clientY,
                    feature: null,
                    original: document
                  };
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
              />
              <text
                x='0'
                y={document.envelope.height + 18 / scale}
                fontSize={12 / scale}
              >
                {document.envelope.width} × {document.envelope.height} mm (depth{' '}
                {document.envelope.depth} mm)
              </text>
            </g>
          </svg>
        </Paper>
        <Paper withBorder p='sm' w={250}>
          <Stack>
            <Text fw={600}>{t`Properties`}</Text>
            {selected ? (
              <>
                <Text>
                  {selected.type} · {selected.id.slice(0, 8)}
                </Text>
                {(['x', 'y', 'width', 'height'] as const).map((key) => (
                  <NumberInput
                    key={key}
                    label={`${key} (mm)`}
                    value={selected[key]}
                    min={key === 'width' || key === 'height' ? 1 : 0}
                    onChange={(value) =>
                      update(selected.id, {
                        [key]: value === '' ? Number.NaN : Number(value)
                      })
                    }
                    error={
                      selected[key] === undefined ||
                      !Number.isFinite(selected[key]) ||
                      (key === 'width' || key === 'height'
                        ? selected[key] <= 0
                        : selected[key] < 0) ||
                      (key === 'x' &&
                        selected.x + selected.width >
                          document.envelope.width) ||
                      (key === 'y' &&
                        selected.y + selected.height > document.envelope.height)
                    }
                    disabled={readOnly}
                  />
                ))}
              </>
            ) : (
              <Text>{t`Select a feature to edit numeric dimensions.`}</Text>
            )}
            {(['width', 'height', 'depth'] as const).map((key) => (
              <NumberInput
                key={key}
                label={`Cabinet ${key} (mm)`}
                value={document.envelope[key]}
                min={1}
                onChange={(value) =>
                  commit({
                    ...document,
                    envelope: {
                      ...document.envelope,
                      [key]: value === '' ? Number.NaN : Number(value)
                    }
                  })
                }
                error={
                  !Number.isFinite(document.envelope[key]) ||
                  document.envelope[key] <= 0
                }
                disabled={readOnly}
              />
            ))}
          </Stack>
        </Paper>
      </Group>
    </Stack>
  );
}
