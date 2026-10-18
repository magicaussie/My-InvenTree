/**
 * Shared SVG rectangle editor.
 *
 * Both the cabinet designer (front view) and the drawer designer (top-down
 * bin plane) are the same interactive canvas: an SVG surface with pan/zoom,
 * pointer-driven move/resize with grid snapping, marquee-free multi-select
 * translation, and a full keyboard equivalent.
 *
 * Design notes:
 * - Only integer canvas units are persisted. Zoom and screen pixels are never
 *   part of the model (design sections 6 and 7).
 * - Dragging an out-of-bounds candidate is drawn red and is **not** committed.
 *   Overlapping candidates *are* committed, but are rendered using the supplied
 *   diagnostic severity so the error is visible and linked to the error list.
 * - Pointer Events are used throughout, so no canvas library is required.
 */

import { t } from '@lingui/core/macro';
import {
  ActionIcon,
  Badge,
  Group,
  Paper,
  Stack,
  Text,
  Tooltip
} from '@mantine/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  type Bounds,
  clampRect,
  moveRects,
  RESIZE_HANDLES,
  type Rect,
  type ResizeHandle,
  resizeRect,
  snapRect,
  type Viewport,
  viewportToCanvas,
  zoomAtPoint
} from '../../state/geometry';

export interface CanvasEntity {
  id: string;
  label: string;
  rect: Rect;
  archived?: boolean;
  severity?: 'error' | 'warning' | null;
  /** Optional secondary text (e.g. LED range) drawn under the label. */
  detail?: string;
}

export type DragPhase = 'move' | 'end';

export interface EditorCanvasProps {
  bounds: Bounds;
  entities: CanvasEntity[];
  selection: string[];
  ariaLabel: string;
  grid?: number;
  snap?: boolean;
  /** Optional overlay rendered beneath entities (allocation bands, etc.). */
  overlay?: React.ReactNode;
  /** Entity id highlighted by the simulation preview. */
  highlightId?: string | null;
  /** Live LED count label for the highlighted entity. */
  highlightLabel?: string | null;
  onSelect: (id: string, additive: boolean) => void;
  onClearSelection?: () => void;
  onMove: (ids: string[], dx: number, dy: number, phase: DragPhase) => void;
  onResize: (id: string, rect: Rect, phase: DragPhase) => void;
  onActivate?: (id: string) => void;
}

interface DragState {
  kind: 'move' | 'resize';
  ids: string[];
  handle?: ResizeHandle;
  startX: number;
  startY: number;
  originRects: Record<string, Rect>;
  preview: Record<string, Rect>;
  outOfBounds: boolean;
  moved: boolean;
}

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 20;

function severityColor(
  severity: EditorCanvasProps['entities'][number]['severity']
) {
  if (severity === 'error') return 'var(--mantine-color-red-6)';
  if (severity === 'warning') return 'var(--mantine-color-yellow-6)';
  return 'var(--mantine-color-blue-6)';
}

export function EditorCanvas(props: EditorCanvasProps) {
  const {
    bounds,
    entities,
    selection,
    ariaLabel,
    grid = 1,
    snap = true,
    overlay,
    highlightId,
    highlightLabel,
    onSelect,
    onClearSelection,
    onMove,
    onResize,
    onActivate
  } = props;

  const svgRef = useRef<SVGSVGElement | null>(null);
  const [viewport, setViewport] = useState<Viewport>({
    zoom: 1,
    offsetX: 0,
    offsetY: 0
  });
  const [drag, setDrag] = useState<DragState | null>(null);
  const pointerIdRef = useRef<number | null>(null);

  const entityMap = useMemo(() => {
    const map: Record<string, CanvasEntity> = {};
    for (const entity of entities) map[entity.id] = entity;
    return map;
  }, [entities]);

  const snapEnabled = snap;

  const toCanvas = useCallback(
    (clientX: number, clientY: number) => {
      const svg = svgRef.current;
      if (!svg) return { x: 0, y: 0 };
      const rect = svg.getBoundingClientRect();
      return viewportToCanvas(
        { x: clientX - rect.left, y: clientY - rect.top },
        viewport
      );
    },
    [viewport]
  );

  const commitDrag = useCallback(
    (state: DragState, cancelled: boolean) => {
      if (!state.moved) return;
      if (cancelled || state.outOfBounds) {
        // Invalid or cancelled candidate: nothing is committed.
        return;
      }
      if (state.kind === 'move') {
        const first = state.ids[0];
        const origin = state.originRects[first];
        const preview = state.preview[first];
        if (!origin || !preview) return;
        onMove(state.ids, preview.x - origin.x, preview.y - origin.y, 'end');
      } else {
        const id = state.ids[0];
        const origin = state.originRects[id];
        const preview = state.preview[id];
        if (!origin || !preview) return;
        if (
          origin.x === preview.x &&
          origin.y === preview.y &&
          origin.width === preview.width &&
          origin.height === preview.height
        ) {
          return;
        }
        onResize(id, preview, 'end');
      }
    },
    [onMove, onResize]
  );

  const handlePointerDown = useCallback(
    (
      event: React.PointerEvent<SVGElement>,
      entity: CanvasEntity,
      handle?: ResizeHandle
    ) => {
      if (event.button !== 0 || pointerIdRef.current !== null) return;
      event.preventDefault();
      event.stopPropagation();
      svgRef.current?.focus();

      const additive = event.shiftKey || event.metaKey || event.ctrlKey;
      if (!handle && additive && selection.includes(entity.id)) {
        // A toggle removes this entity; do not start moving the old selection.
        onSelect(entity.id, true);
        return;
      }
      const ids = handle
        ? [entity.id]
        : !additive && selection.includes(entity.id)
          ? selection
          : additive
            ? [...selection, entity.id]
            : [entity.id];

      if (handle === undefined && !selection.includes(entity.id)) {
        onSelect(entity.id, additive);
      }

      const originRects: Record<string, Rect> = {};
      for (const id of ids) {
        const target = entityMap[id];
        if (target) originRects[id] = { ...target.rect };
      }

      const start = toCanvas(event.clientX, event.clientY);

      pointerIdRef.current = event.pointerId;
      // Capture on the stable SVG, never on a resize handle that may rerender.
      svgRef.current?.setPointerCapture?.(event.pointerId);

      setDrag({
        kind: handle ? 'resize' : 'move',
        ids,
        handle,
        startX: start.x,
        startY: start.y,
        originRects,
        preview: { ...originRects },
        outOfBounds: false,
        moved: false
      });
    },
    [entityMap, onSelect, selection, toCanvas]
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<SVGElement>) => {
      if (!drag || pointerIdRef.current !== event.pointerId) return;
      const current = toCanvas(event.clientX, event.clientY);
      const rawDx = current.x - drag.startX;
      const rawDy = current.y - drag.startY;

      if (drag.kind === 'move') {
        let dx = snapEnabled
          ? Math.round(rawDx / grid) * grid
          : Math.round(rawDx);
        let dy = snapEnabled
          ? Math.round(rawDy / grid) * grid
          : Math.round(rawDy);

        // Clamp the whole selection so it stays inside the bounds.
        const rects = Object.values(drag.originRects);
        let minDx = dx;
        let maxDx = dx;
        let minDy = dy;
        let maxDy = dy;
        for (const rect of rects) {
          minDx = Math.max(minDx, -rect.x);
          maxDx = Math.min(maxDx, bounds.width - rect.width - rect.x);
          minDy = Math.max(minDy, -rect.y);
          maxDy = Math.min(maxDy, bounds.height - rect.height - rect.y);
        }
        dx = Math.min(Math.max(dx, minDx), maxDx);
        dy = Math.min(Math.max(dy, minDy), maxDy);

        const preview = moveRects(drag.originRects, dx, dy);
        setDrag({
          ...drag,
          preview,
          moved: dx !== 0 || dy !== 0,
          outOfBounds: false
        });
        return;
      }

      const id = drag.ids[0];
      const origin = drag.originRects[id];
      if (!origin || !drag.handle) return;

      let candidate = resizeRect(origin, drag.handle, rawDx, rawDy, {
        grid: snapEnabled ? grid : 1,
        minSize: 1
      });

      const outOfBounds = !isInside(candidate, bounds);
      const clamped = outOfBounds ? candidate : clampRect(candidate, bounds);
      candidate = snappedIfNeeded(clamped, snapEnabled ? grid : 1);

      setDrag({
        ...drag,
        preview: { [id]: candidate },
        moved: true,
        outOfBounds
      });
    },
    [drag, grid, snapEnabled, bounds, toCanvas]
  );

  const finishPointer = useCallback(
    (cancelled: boolean) => {
      if (!drag) return;
      const pointerId = pointerIdRef.current;
      pointerIdRef.current = null;
      setDrag(null);
      const svg = svgRef.current;
      if (pointerId !== null && svg?.hasPointerCapture?.(pointerId)) {
        svg.releasePointerCapture(pointerId);
      }
      commitDrag(drag, cancelled);
    },
    [commitDrag, drag]
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<SVGElement>) => {
      if (!drag || pointerIdRef.current !== event.pointerId) return;
      finishPointer(false);
    },
    [drag, finishPointer]
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<SVGSVGElement>) => {
      if (drag) {
        if (event.key === 'Escape') {
          event.preventDefault();
          finishPointer(true);
        }
        return;
      }

      if (selection.length === 0) return;

      const step = event.shiftKey ? grid * 10 || 10 : grid || 1;
      const moves: Record<string, { dx: number; dy: number }> = {
        ArrowLeft: { dx: -step, dy: 0 },
        ArrowRight: { dx: step, dy: 0 },
        ArrowUp: { dx: 0, dy: -step },
        ArrowDown: { dx: 0, dy: step }
      };

      const move = moves[event.key];
      if (move) {
        event.preventDefault();
        onMove(selection, move.dx, move.dy, 'end');
        return;
      }

      if (event.key === 'Enter') {
        event.preventDefault();
        if (selection.length === 1 && onActivate) onActivate(selection[0]);
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        onClearSelection?.();
      }
    },
    [drag, finishPointer, grid, onActivate, onClearSelection, onMove, selection]
  );

  const handleWheel = useCallback((event: WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    if (pointerIdRef.current !== null) return;
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;

    setViewport((current) => {
      const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
      const zoom = Math.min(
        MAX_ZOOM,
        Math.max(MIN_ZOOM, current.zoom * factor)
      );
      return zoomAtPoint(current, { x: pointerX, y: pointerY }, zoom);
    });
  }, []);

  useEffect(() => {
    const svg = svgRef.current;
    // React's wheel listener is passive: a native non-passive listener is
    // required to keep Ctrl-wheel from also zooming the browser page.
    svg?.addEventListener('wheel', handleWheel, { passive: false });
    return () => svg?.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  const zoomBy = useCallback((factor: number) => {
    if (pointerIdRef.current !== null) return;
    setViewport((current) => ({
      ...current,
      zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current.zoom * factor))
    }));
  }, []);

  const resetView = useCallback(() => {
    if (pointerIdRef.current !== null) return;
    setViewport({ zoom: 1, offsetX: 0, offsetY: 0 });
  }, []);

  // Escape cancels an in-progress drag even if focus left the svg.
  useEffect(() => {
    if (!drag) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') finishPointer(true);
    };
    const onBlur = () => finishPointer(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onBlur);
    };
  }, [drag, finishPointer]);

  const handleSize = 8 / viewport.zoom;
  const transform = `translate(${viewport.offsetX} ${viewport.offsetY}) scale(${viewport.zoom})`;

  return (
    <Stack gap='xs' h='100%'>
      <Group justify='space-between'>
        <Group gap='xs'>
          <Tooltip label={t`Zoom in`}>
            <ActionIcon
              variant='default'
              aria-label={t`Zoom in`}
              onClick={() => zoomBy(1.2)}
            >
              +
            </ActionIcon>
          </Tooltip>
          <Tooltip label={t`Zoom out`}>
            <ActionIcon
              variant='default'
              aria-label={t`Zoom out`}
              onClick={() => zoomBy(1 / 1.2)}
            >
              -
            </ActionIcon>
          </Tooltip>
          <Tooltip label={t`Reset view`}>
            <ActionIcon
              variant='default'
              aria-label={t`Reset view`}
              onClick={resetView}
            >
              o
            </ActionIcon>
          </Tooltip>
          <Text size='xs' c='dimmed'>
            {Math.round(viewport.zoom * 100)}%
          </Text>
        </Group>
        <Badge variant='light' data-testid='entity-count'>
          {entities.length === 1
            ? t`${entities.length} item`
            : t`${entities.length} items`}
        </Badge>
      </Group>

      <Paper
        withBorder
        p={0}
        style={{ flex: 1, minHeight: 240, overflow: 'hidden' }}
      >
        <svg
          ref={svgRef}
          role='application'
          aria-label={ariaLabel}
          tabIndex={0}
          width='100%'
          height='100%'
          style={{ display: 'block', touchAction: 'none', outline: 'none' }}
          onKeyDown={handleKeyDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={(event) => {
            if (pointerIdRef.current === event.pointerId) finishPointer(true);
          }}
          onLostPointerCapture={(event) => {
            if (pointerIdRef.current === event.pointerId) finishPointer(true);
          }}
          onPointerDown={(event) => {
            if (
              event.button === 0 &&
              pointerIdRef.current === null &&
              event.target === svgRef.current
            ) {
              onClearSelection?.();
            }
          }}
        >
          <g transform={transform}>
            <rect
              pointerEvents='none'
              x={0}
              y={0}
              width={bounds.width}
              height={bounds.height}
              fill='var(--mantine-color-body)'
              stroke='var(--mantine-color-gray-5)'
            />
            <g pointerEvents='none'>{overlay}</g>
            {entities.map((entity) => {
              const live = drag?.preview[entity.id];
              const rect = live ?? entity.rect;
              const selected = selection.includes(entity.id);
              const isDragOutOfBounds =
                drag?.outOfBounds && drag.ids.includes(entity.id);
              const severity = isDragOutOfBounds ? 'error' : entity.severity;
              const highlighted =
                highlightId === entity.id ||
                (drag?.ids.includes(entity.id) ?? false);

              return (
                <g key={entity.id}>
                  {/* biome-ignore lint/a11y/noStaticElementInteractions: SVG rect is the pointer-editable entity; the accessible keyboard path is the canvas */}
                  <rect
                    x={rect.x}
                    y={rect.y}
                    width={rect.width}
                    height={rect.height}
                    rx={2}
                    fill={
                      highlighted
                        ? 'var(--mantine-color-green-2)'
                        : selected
                          ? 'var(--mantine-color-blue-1)'
                          : entity.archived
                            ? 'var(--mantine-color-gray-3)'
                            : 'var(--mantine-color-gray-1)'
                    }
                    stroke={severityColor(severity)}
                    strokeWidth={(selected ? 2 : 1) / viewport.zoom}
                    strokeDasharray={
                      entity.archived
                        ? `${4 / viewport.zoom} ${2 / viewport.zoom}`
                        : undefined
                    }
                    style={{ cursor: 'move' }}
                    onPointerDown={(event) => handlePointerDown(event, entity)}
                    onDoubleClick={() => onActivate?.(entity.id)}
                  />
                  <text
                    x={rect.x + 4}
                    y={rect.y + 14}
                    fontSize={12}
                    fill='var(--mantine-color-text)'
                    pointerEvents='none'
                  >
                    {entity.label}
                  </text>
                  {entity.detail ? (
                    <text
                      x={rect.x + 4}
                      y={rect.y + 28}
                      fontSize={10}
                      fill='var(--mantine-color-dimmed)'
                      pointerEvents='none'
                    >
                      {entity.detail}
                    </text>
                  ) : null}
                </g>
              );
            })}
            {entities
              .filter((entity) => selection.includes(entity.id))
              .map((entity) => {
                const rect = drag?.preview[entity.id] ?? entity.rect;
                return (
                  <g key={`handles-${entity.id}`}>
                    {RESIZE_HANDLES.map((handle) => {
                      const point = handlePoint(rect, handle);
                      return (
                        <rect
                          key={handle}
                          x={point.x - handleSize / 2}
                          y={point.y - handleSize / 2}
                          width={handleSize}
                          height={handleSize}
                          fill='var(--mantine-color-blue-6)'
                          aria-hidden
                          style={{
                            cursor: `${handle}-resize`
                          }}
                          onPointerDown={(event) =>
                            handlePointerDown(event, entity, handle)
                          }
                        />
                      );
                    })}
                  </g>
                );
              })}
          </g>
        </svg>
      </Paper>

      {highlightLabel ? (
        <Text size='xs' c='green'>
          {highlightLabel}
        </Text>
      ) : null}
    </Stack>
  );
}

function handlePoint(rect: Rect, handle: ResizeHandle) {
  const midX = rect.x + rect.width / 2;
  const midY = rect.y + rect.height / 2;
  switch (handle) {
    case 'nw':
      return { x: rect.x, y: rect.y };
    case 'n':
      return { x: midX, y: rect.y };
    case 'ne':
      return { x: rect.x + rect.width, y: rect.y };
    case 'e':
      return { x: rect.x + rect.width, y: midY };
    case 'se':
      return { x: rect.x + rect.width, y: rect.y + rect.height };
    case 's':
      return { x: midX, y: rect.y + rect.height };
    case 'sw':
      return { x: rect.x, y: rect.y + rect.height };
    case 'w':
      return { x: rect.x, y: midY };
  }
}

function isInside(rect: Rect, bounds: Bounds): boolean {
  return (
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.x + rect.width <= bounds.width &&
    rect.y + rect.height <= bounds.height
  );
}

function snappedIfNeeded(rect: Rect, grid: number): Rect {
  return grid > 1 ? snapRect(rect, grid) : rect;
}
