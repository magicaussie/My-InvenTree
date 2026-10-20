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
  Button,
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
  fitViewport,
  MAX_ZOOM,
  MIN_ZOOM,
  moveRects,
  RESIZE_HANDLES,
  type Rect,
  type ResizeHandle,
  resizeRect,
  snapRect,
  translatedPan,
  type Viewport,
  viewportToCanvas,
  zoomAtPoint
} from '../../state/geometry';

export interface CanvasEntity {
  id: string;
  label: string;
  rect: Rect;
  archived?: boolean;
  fillOpacity?: number;
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
  onDraw?: (rect: Rect) => void;
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

interface PanState {
  kind: 'pan';
  start: { x: number; y: number };
  origin: Viewport;
}

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
    onDraw,
    onActivate
  } = props;

  const svgRef = useRef<SVGSVGElement | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const autoFitRef = useRef(true);
  const [workspaceHeight, setWorkspaceHeight] = useState(480);

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const measure = () => {
      // Resolve against the viewport, not an indefinite percentage-height chain.
      // Keep a usable surface when responsive toolbars stack above the canvas.
      setWorkspaceHeight(
        Math.max(
          320,
          window.innerHeight - workspace.getBoundingClientRect().top - 24
        )
      );
    };
    measure();
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(measure);
    observer?.observe(workspace);
    if (workspace.parentElement) observer?.observe(workspace.parentElement);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);
  const [viewport, setViewport] = useState<Viewport>({
    zoom: 1,
    offsetX: 0,
    offsetY: 0
  });
  const viewportRef = useRef(viewport);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [pan, setPan] = useState<PanState | null>(null);
  const panRef = useRef<PanState | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const spaceHeldRef = useRef(false);
  const pointerIdRef = useRef<number | null>(null);
  const [gridVisible, setGridVisible] = useState(true);
  const [interactionMode, setInteractionMode] = useState<
    'select' | 'draw' | 'pan'
  >('select');
  const [drawPreview, setDrawPreview] = useState<Rect | null>(null);
  const drawPreviewRef = useRef<Rect | null>(null);
  const drawStart = useRef<{ x: number; y: number } | null>(null);

  // Event refs mirror the rendered state synchronously, so capture/move/up
  // sequences do not depend on React having rendered between pointer events.
  const updateViewport = useCallback(
    (next: Viewport | ((current: Viewport) => Viewport)) => {
      const value =
        typeof next === 'function' ? next(viewportRef.current) : next;
      autoFitRef.current = false;
      viewportRef.current = value;
      setViewport(value);
    },
    []
  );
  const updateDrag = useCallback((next: DragState | null) => {
    dragRef.current = next;
    setDrag(next);
  }, []);
  const updateSpace = useCallback((held: boolean) => {
    spaceHeldRef.current = held;
    setSpaceHeld(held);
  }, []);

  const entityMap = useMemo(() => {
    const map: Record<string, CanvasEntity> = {};
    for (const entity of entities) map[entity.id] = entity;
    return map;
  }, [entities]);

  const snapEnabled = snap;
  const canvasWidth =
    Number.isFinite(bounds.width) && bounds.width > 0 ? bounds.width : 0;
  const canvasHeight =
    Number.isFinite(bounds.height) && bounds.height > 0 ? bounds.height : 0;
  const validCanvasBounds = canvasWidth > 0 && canvasHeight > 0;
  const gridXCount =
    validCanvasBounds && Number.isFinite(grid) && grid > 0
      ? Math.min(Math.floor(canvasWidth / grid) + 1, 1000)
      : 0;
  const gridYCount =
    validCanvasBounds && Number.isFinite(grid) && grid > 0
      ? Math.min(Math.floor(canvasHeight / grid) + 1, 1000)
      : 0;

  const toCanvas = useCallback((clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    return viewportToCanvas(
      { x: clientX - rect.left, y: clientY - rect.top },
      viewportRef.current
    );
  }, []);

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

  const handlePanStart = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      if (pointerIdRef.current !== null) return;
      if (
        event.button !== 1 &&
        !(
          event.button === 0 &&
          (spaceHeldRef.current || interactionMode === 'pan')
        )
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      const svg = svgRef.current;
      svg?.focus();
      const next: PanState = {
        kind: 'pan',
        start: { x: event.clientX, y: event.clientY },
        origin: viewportRef.current
      };
      panRef.current = next;
      setPan(next);
      pointerIdRef.current = event.pointerId;
      svg?.setPointerCapture?.(event.pointerId);
    },
    [interactionMode]
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
      const candidates = handle
        ? [entity.id]
        : !additive && selection.includes(entity.id)
          ? selection
          : additive
            ? [...selection, entity.id]
            : [entity.id];
      // Archived entities stay selectable for inspection but never move.
      // Excluding them here keeps the drag preview, bounds clamping and the
      // committed delta limited to active drawers, so an archived selection
      // cannot shift an active drawer or over-clamp its movement.
      const ids = candidates.filter((id) => !entityMap[id]?.archived);

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

      updateDrag({
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
    [entityMap, onSelect, selection, toCanvas, updateDrag]
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<SVGElement>) => {
      if (pointerIdRef.current !== event.pointerId) return;
      if (drawStart.current) {
        const point = toCanvas(event.clientX, event.clientY);
        const start = drawStart.current;
        const snapValue = snapEnabled ? grid : 1;
        const x1 =
          Math.round(Math.min(start.x, point.x) / snapValue) * snapValue;
        const y1 =
          Math.round(Math.min(start.y, point.y) / snapValue) * snapValue;
        const x2 =
          Math.round(Math.max(start.x, point.x) / snapValue) * snapValue;
        const y2 =
          Math.round(Math.max(start.y, point.y) / snapValue) * snapValue;
        const preview = { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
        drawPreviewRef.current = preview;
        setDrawPreview(preview);
        return;
      }
      const pan = panRef.current;
      if (pan) {
        updateViewport(
          translatedPan(pan.origin, pan.start, {
            x: event.clientX,
            y: event.clientY
          })
        );
        return;
      }
      const drag = dragRef.current;
      if (!drag) return;
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
        updateDrag({
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

      updateDrag({
        ...drag,
        preview: { [id]: candidate },
        moved: true,
        outOfBounds
      });
    },
    [grid, snapEnabled, bounds, toCanvas, updateDrag, updateViewport]
  );

  const finishPointer = useCallback(
    (cancelled: boolean) => {
      const pointerId = pointerIdRef.current;
      if (pointerId === null) return;
      if (drawStart.current) {
        const preview = drawPreviewRef.current;
        drawStart.current = null;
        drawPreviewRef.current = null;
        setDrawPreview(null);
        if (!cancelled && preview && preview.width > 0 && preview.height > 0) {
          onDraw?.(preview);
        }
      }
      const drag = dragRef.current;
      const pan = panRef.current;
      pointerIdRef.current = null;
      panRef.current = null;
      setPan(null);
      updateDrag(null);
      if (pan && cancelled) updateViewport(pan.origin);
      const svg = svgRef.current;
      if (svg?.hasPointerCapture?.(pointerId)) {
        svg.releasePointerCapture(pointerId);
      }
      if (drag) commitDrag(drag, cancelled);
    },
    [commitDrag, onDraw, updateDrag, updateViewport]
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<SVGElement>) => {
      if (pointerIdRef.current !== event.pointerId) return;
      finishPointer(false);
    },
    [finishPointer]
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<SVGSVGElement>) => {
      if (isTextInput(event.target)) return;
      if (event.key === ' ' || event.code === 'Space') {
        event.preventDefault();
        updateSpace(true);
        return;
      }
      if (pointerIdRef.current !== null) {
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
    [
      finishPointer,
      grid,
      onActivate,
      onClearSelection,
      onMove,
      selection,
      updateSpace
    ]
  );

  const handleWheel = useCallback(
    (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      if (pointerIdRef.current !== null) return;
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const pointerX = event.clientX - rect.left;
      const pointerY = event.clientY - rect.top;

      updateViewport((current) => {
        const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
        const zoom = Math.min(
          MAX_ZOOM,
          Math.max(MIN_ZOOM, current.zoom * factor)
        );
        return zoomAtPoint(current, { x: pointerX, y: pointerY }, zoom);
      });
    },
    [updateViewport]
  );

  useEffect(() => {
    const svg = svgRef.current;
    // React's wheel listener is passive: a native non-passive listener is
    // required to keep Ctrl-wheel from also zooming the browser page.
    svg?.addEventListener('wheel', handleWheel, { passive: false });
    return () => svg?.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  const zoomBy = useCallback(
    (factor: number) => {
      if (pointerIdRef.current !== null) return;
      const screen = svgRef.current?.getBoundingClientRect();
      if (
        !screen ||
        ![screen.width, screen.height].every((n) => Number.isFinite(n) && n > 0)
      )
        return;
      updateViewport((current) =>
        zoomAtPoint(
          current,
          { x: screen.width / 2, y: screen.height / 2 },
          Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current.zoom * factor))
        )
      );
    },
    [updateViewport]
  );

  const resetView = useCallback(() => {
    if (pointerIdRef.current !== null) return;
    updateViewport({ zoom: 1, offsetX: 0, offsetY: 0 });
  }, [updateViewport]);

  const fitView = useCallback(() => {
    if (pointerIdRef.current !== null) return;
    const screen = svgRef.current?.getBoundingClientRect();
    if (!screen) return;
    const next = fitViewport(bounds, screen);
    if (next) {
      updateViewport(next);
      autoFitRef.current = true;
    }
  }, [bounds, updateViewport]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const screen = svg.getBoundingClientRect();
      const fitted = fitViewport(
        { width: canvasWidth, height: canvasHeight },
        screen
      );
      if (fitted && autoFitRef.current && pointerIdRef.current === null) {
        viewportRef.current = fitted;
        setViewport((current) =>
          current.zoom === fitted.zoom &&
          current.offsetX === fitted.offsetX &&
          current.offsetY === fitted.offsetY
            ? current
            : fitted
        );
      }
    });
    observer.observe(svg);
    return () => observer.disconnect();
  }, [canvasWidth, canvasHeight]);

  // Escape/blur cancels either interaction even if focus left the SVG.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && pointerIdRef.current !== null) {
        event.preventDefault();
        finishPointer(true);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === ' ' || event.code === 'Space') updateSpace(false);
    };
    const onBlur = () => {
      updateSpace(false);
      finishPointer(true);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [finishPointer, updateSpace]);

  useEffect(() => {
    const svg = svgRef.current;
    return () => {
      const pointerId = pointerIdRef.current;
      pointerIdRef.current = null;
      drawStart.current = null;
      drawPreviewRef.current = null;
      if (pointerId !== null && svg?.hasPointerCapture?.(pointerId)) {
        svg.releasePointerCapture(pointerId);
      }
    };
  }, []);

  const panCursor = pan
    ? 'grabbing'
    : spaceHeld || interactionMode === 'pan'
      ? 'grab'
      : undefined;

  const handleSize = 8 / viewport.zoom;
  const transform = `translate(${viewport.offsetX} ${viewport.offsetY}) scale(${viewport.zoom})`;

  return (
    <Stack
      ref={workspaceRef}
      gap='xs'
      style={{ height: workspaceHeight, minHeight: 320, flexShrink: 0 }}
    >
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
          <Tooltip label={t`Fit to view`}>
            <ActionIcon
              variant='default'
              aria-label={t`Fit to view`}
              onClick={fitView}
            >
              ⤢
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
          {(
            ['select', ...(onDraw ? ['draw' as const] : []), 'pan'] as const
          ).map((mode) => (
            <Button
              key={mode}
              size='compact-xs'
              variant={interactionMode === mode ? 'filled' : 'default'}
              aria-pressed={interactionMode === mode}
              onClick={() => setInteractionMode(mode)}
              aria-label={
                mode === 'select'
                  ? t`Select mode`
                  : mode === 'draw'
                    ? t`Draw mode`
                    : t`Pan mode`
              }
            >
              {mode === 'select'
                ? t`Select`
                : mode === 'draw'
                  ? interactionMode === 'draw'
                    ? t`Drawing — drag to create`
                    : t`Draw`
                  : t`Pan`}
            </Button>
          ))}
          <Button
            size='compact-xs'
            variant={gridVisible ? 'light' : 'default'}
            aria-pressed={gridVisible}
            onClick={() => setGridVisible((visible) => !visible)}
          >
            {t`Grid`}
          </Button>
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
        style={{
          flex: 1,
          minHeight: 240,
          overflow: 'hidden',
          position: 'relative'
        }}
      >
        <svg
          ref={svgRef}
          role='application'
          aria-label={ariaLabel}
          tabIndex={0}
          width='100%'
          height='100%'
          style={{
            display: 'block',
            position: 'absolute',
            inset: 0,
            touchAction: 'none',
            outline: 'none',
            cursor:
              panCursor ??
              (interactionMode === 'draw'
                ? 'crosshair'
                : interactionMode === 'pan'
                  ? 'grab'
                  : undefined)
          }}
          onKeyDown={handleKeyDown}
          onBlur={() => updateSpace(false)}
          onPointerDownCapture={handlePanStart}
          onAuxClick={(event) => {
            if (event.button === 1) event.preventDefault();
          }}
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
              if (interactionMode === 'draw' && onDraw) {
                const point = toCanvas(event.clientX, event.clientY);
                drawStart.current = point;
                const preview = { x: point.x, y: point.y, width: 0, height: 0 };
                drawPreviewRef.current = preview;
                setDrawPreview(preview);
                pointerIdRef.current = event.pointerId;
                svgRef.current?.setPointerCapture?.(event.pointerId);
                return;
              }
              onClearSelection?.();
            }
          }}
        >
          <g transform={transform}>
            <rect
              pointerEvents='none'
              x={0}
              y={0}
              width={canvasWidth}
              height={canvasHeight}
              fill='var(--mantine-color-body)'
              stroke='var(--mantine-color-gray-5)'
            />
            {gridVisible && gridXCount > 0 && gridYCount > 0 ? (
              <g
                pointerEvents='none'
                stroke='var(--mantine-color-gray-3)'
                strokeWidth={0.5 / viewport.zoom}
              >
                {Array.from(
                  { length: gridXCount },
                  (_, index) => index * grid
                ).map((position) => (
                  <line
                    data-grid-line='x'
                    key={`grid-x-${position}`}
                    x1={position}
                    y1={0}
                    x2={position}
                    y2={canvasHeight}
                  />
                ))}
                {Array.from(
                  { length: gridYCount },
                  (_, index) => index * grid
                ).map((position) => (
                  <line
                    data-grid-line='y'
                    key={`grid-y-${position}`}
                    x1={0}
                    y1={position}
                    x2={canvasWidth}
                    y2={position}
                  />
                ))}
              </g>
            ) : null}
            <g pointerEvents='none'>{overlay}</g>
            {drawPreview ? (
              <rect
                x={drawPreview.x}
                y={drawPreview.y}
                width={drawPreview.width}
                height={drawPreview.height}
                fill='var(--mantine-color-blue-2)'
                fillOpacity={0.45}
                stroke='var(--mantine-color-blue-7)'
                strokeDasharray='4 2'
                pointerEvents='none'
              />
            ) : null}
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
                    fillOpacity={entity.fillOpacity}
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
                    style={{ cursor: panCursor ?? 'move' }}
                    onPointerDown={(event) => handlePointerDown(event, entity)}
                    onDoubleClick={(event) => {
                      if (
                        event.button === 0 &&
                        !spaceHeldRef.current &&
                        !panRef.current
                      )
                        onActivate?.(entity.id);
                    }}
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
                  {selected ? (
                    <g
                      pointerEvents='none'
                      fill='var(--mantine-color-blue-7)'
                      stroke='var(--mantine-color-blue-7)'
                      strokeWidth={0.75 / viewport.zoom}
                      fontSize={10 / viewport.zoom}
                    >
                      <line
                        x1={rect.x}
                        y1={rect.y - 3 / viewport.zoom}
                        x2={rect.x + rect.width}
                        y2={rect.y - 3 / viewport.zoom}
                      />
                      <line
                        x1={rect.x - 3 / viewport.zoom}
                        y1={rect.y}
                        x2={rect.x - 3 / viewport.zoom}
                        y2={rect.y + rect.height}
                      />
                      <text
                        x={rect.x + rect.width / 2}
                        y={rect.y - 6 / viewport.zoom}
                        textAnchor='middle'
                        stroke='none'
                      >
                        {`${rect.width} × ${rect.height}`}
                      </text>
                      <text
                        x={rect.x}
                        y={rect.y + rect.height + 12 / viewport.zoom}
                        stroke='none'
                      >
                        {`x ${rect.x}, y ${rect.y}`}
                      </text>
                    </g>
                  ) : null}
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
              .filter(
                (entity) => selection.includes(entity.id) && !entity.archived
              )
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
                            cursor: panCursor ?? `${handle}-resize`
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

function isTextInput(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        'input, textarea, select, [contenteditable]:not([contenteditable="false"])'
      )
    )
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
