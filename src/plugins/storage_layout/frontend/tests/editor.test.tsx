import type { InvenTreePluginContext } from '@inventreedb/ui';
import { MantineProvider } from '@mantine/core';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CabinetDesigner } from '../src/components/CabinetDesigner';
import {
  type CanvasEntity,
  EditorCanvas
} from '../src/components/editor/EditorCanvas';
import { DrawerInspector } from '../src/components/editor/Inspector';
import { ValidationPanel } from '../src/components/editor/Panels';
import { EditorToolbar } from '../src/components/editor/Toolbar';

function wrap(ui: React.ReactNode) {
  return render(<MantineProvider>{ui}</MantineProvider>);
}

const entity = {
  id: 'e1',
  label: 'A1',
  rect: { x: 10, y: 10, width: 20, height: 20 }
};

function canvasFixture(
  selection = ['e1'],
  initialBounds = { width: 100, height: 100 },
  entities?: CanvasEntity[]
) {
  const onMove = vi.fn();
  const onResize = vi.fn();
  const onSelect = vi.fn();
  const onClearSelection = vi.fn();
  const second = {
    id: 'e2',
    label: 'A2',
    rect: { x: 50, y: 50, width: 20, height: 20 }
  };
  const list = entities ?? [entity, second];
  const canvas = (bounds = initialBounds) => (
    <EditorCanvas
      bounds={bounds}
      entities={list}
      selection={selection}
      grid={1}
      snap={false}
      ariaLabel='regression canvas'
      overlay={<rect data-testid='overlay' width={100} height={100} />}
      onSelect={onSelect}
      onClearSelection={onClearSelection}
      onMove={onMove}
      onResize={onResize}
    />
  );
  const { container, rerender } = wrap(canvas());
  const rerenderCanvas = (bounds = initialBounds) =>
    rerender(<MantineProvider>{canvas(bounds)}</MantineProvider>);
  const svg = screen.getByRole('application', { name: 'regression canvas' });
  const measurement = vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 100,
    bottom: 100,
    width: 100,
    height: 100,
    toJSON: () => ({})
  });
  const capture = vi.fn();
  const release = vi.fn();
  Object.defineProperties(svg, {
    setPointerCapture: { configurable: true, value: capture },
    releasePointerCapture: { configurable: true, value: release },
    hasPointerCapture: { configurable: true, value: () => true }
  });
  const rects = Array.from(container.querySelectorAll('rect[style*="move"]'));
  const handle = () => {
    const result = container.querySelector('rect[style*="se-resize"]');
    expect(result).not.toBeNull();
    return result as SVGRectElement;
  };
  const down = (target: Element = rects[0], pointerId = 7) =>
    fireEvent.pointerDown(target, {
      button: 0,
      clientX: 20,
      clientY: 20,
      pointerId
    });
  const move = (dx = 10, dy = 5, pointerId = 7) =>
    fireEvent.pointerMove(svg, {
      clientX: 20 + dx,
      clientY: 20 + dy,
      pointerId
    });
  const up = (pointerId = 7) => fireEvent.pointerUp(svg, { pointerId });
  const zoom = (steps: number) => {
    for (let i = 0; i < Math.abs(steps); i++) {
      fireEvent.wheel(svg, {
        ctrlKey: true,
        deltaY: steps > 0 ? -100 : 100,
        clientX: 0,
        clientY: 0
      });
    }
    return 1.1 ** steps;
  };
  return {
    container,
    svg,
    rects,
    handle,
    down,
    move,
    up,
    zoom,
    capture,
    release,
    onMove,
    onResize,
    onSelect,
    onClearSelection,
    measurement,
    rerenderCanvas
  };
}

function readViewport(svg: Element) {
  const transform = svg
    .querySelector('g[transform]')
    ?.getAttribute('transform');
  expect(transform).toBeDefined();
  const numbers = transform
    ?.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)
    ?.map(Number);
  expect(numbers).toHaveLength(3);
  const [offsetX, offsetY, zoom] = numbers as number[];
  return { offsetX, offsetY, zoom };
}

type CanvasFixture = ReturnType<typeof canvasFixture>;

function startPan(
  fixture: CanvasFixture,
  target: Element = fixture.svg,
  button = 1
) {
  fireEvent.pointerDown(target, {
    button,
    clientX: 20,
    clientY: 20,
    pointerId: 7
  });
}

function expectNoCanvasMutation(fixture: CanvasFixture) {
  expect(fixture.onMove).not.toHaveBeenCalled();
  expect(fixture.onResize).not.toHaveBeenCalled();
  expect(fixture.onSelect).not.toHaveBeenCalled();
  expect(fixture.onClearSelection).not.toHaveBeenCalled();
  expect(fixture.rects[0]).toHaveAttribute('x', '10');
  expect(fixture.rects[0]).toHaveAttribute('y', '10');
  expect(fixture.rects[0]).toHaveAttribute('width', '20');
  expect(fixture.rects[0]).toHaveAttribute('height', '20');
}

describe('EditorCanvas regressions', () => {
  it('keeps the background, entities and non-intercepting overlay in one zoomed group', () => {
    const { svg, rects, zoom, onClearSelection } = canvasFixture();
    const background = svg.querySelector(
      'rect[stroke="var(--mantine-color-gray-5)"]'
    );
    const overlay = screen.getByTestId('overlay');
    const group = rects[0].closest('g[transform]');
    expect(group).not.toBeNull();
    const before = group?.getAttribute('transform');
    zoom(1);
    expect(group?.getAttribute('transform')).not.toBe(before);
    expect(background?.closest('g[transform]')).toBe(group);
    expect(overlay.closest('g[transform]')).toBe(group);
    expect(overlay.parentElement).toHaveAttribute('pointer-events', 'none');
    // jsdom has no SVG hit testing: verify the non-intercepting background
    // policy, then dispatch to the SVG as the browser would.
    expect(background).toHaveAttribute('pointer-events', 'none');
    fireEvent.pointerDown(svg, { button: 0, pointerId: 7 });
    expect(onClearSelection).toHaveBeenCalledTimes(1);
  });

  it.each([0, -7, 7])(
    'converts screen drag deltas at wheel zoom step %i',
    (steps) => {
      const { zoom, down, move, up, onMove, onResize, rects } = canvasFixture();
      // Seven wheel steps approximate 0.5x / 2x; use the actual factor rather
      // than claiming the wheel's 1.1 increments reach those exact scales.
      const scale = zoom(steps);
      down();
      move(10 * scale, 5 * scale);
      expect(rects[0]).toHaveAttribute('x', '20');
      expect(rects[0]).toHaveAttribute('y', '15');
      expect(onMove).not.toHaveBeenCalled();
      up();
      expect(onMove).toHaveBeenCalledExactlyOnceWith(['e1'], 10, 5, 'end');
      expect(onResize).not.toHaveBeenCalled();
    }
  );

  it('resizes only the targeted selected entity after zoom and retains its handle', () => {
    const { zoom, handle, down, move, up, rects, onMove, onResize } =
      canvasFixture(['e2', 'e1']);
    const scale = zoom(7);
    const target = handle();
    // The first handle belongs to e1 although e2 is first in selection.
    down(target);
    move(10 * scale, 5 * scale);
    expect(handle()).toBe(target);
    expect(target.isConnected).toBe(true);
    expect(rects[0]).toHaveAttribute('width', '30');
    expect(rects[0]).toHaveAttribute('height', '25');
    expect(rects[1]).toHaveAttribute('width', '20');
    expect(onResize).not.toHaveBeenCalled();
    up();
    expect(onResize).toHaveBeenCalledExactlyOnceWith(
      'e1',
      { x: 10, y: 10, width: 30, height: 25 },
      'end'
    );
    expect(onMove).not.toHaveBeenCalled();
  });

  it('moves the whole selection with a single command', () => {
    const { down, move, up, rects, onMove, onSelect } = canvasFixture([
      'e1',
      'e2'
    ]);
    down();
    move();
    expect(rects[0]).toHaveAttribute('x', '20');
    expect(rects[1]).toHaveAttribute('x', '60');
    expect(rects[1]).toHaveAttribute('y', '55');
    up();
    expect(onMove).toHaveBeenCalledExactlyOnceWith(['e1', 'e2'], 10, 5, 'end');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it.each(['move', 'resize'])(
    'captures and focuses the SVG, not the %s target',
    (kind) => {
      const { svg, rects, handle, down, up, capture, release } =
        canvasFixture();
      const target = kind === 'move' ? rects[0] : handle();
      const targetCapture = vi.fn();
      Object.defineProperty(target, 'setPointerCapture', {
        value: targetCapture
      });
      down(target);
      expect(document.activeElement).toBe(svg);
      expect(capture).toHaveBeenCalledExactlyOnceWith(7);
      expect(targetCapture).not.toHaveBeenCalled();
      up();
      expect(release).toHaveBeenCalledExactlyOnceWith(7);
    }
  );

  it.each([
    ['move', 'Escape'],
    ['resize', 'Escape'],
    ['move', 'pointercancel'],
    ['resize', 'pointercancel'],
    ['move', 'lostpointercapture'],
    ['resize', 'lostpointercapture']
  ])(
    'cancels %s on %s, resets preview and permits a fresh drag',
    (kind, reason) => {
      const { svg, rects, handle, down, move, up, release, onMove, onResize } =
        canvasFixture();
      down(kind === 'move' ? rects[0] : handle());
      move();
      expect(rects[0]).toHaveAttribute(
        kind === 'move' ? 'x' : 'width',
        kind === 'move' ? '20' : '30'
      );
      if (reason === 'Escape') {
        fireEvent.keyDown(window, { key: 'Escape' });
      } else if (reason === 'pointercancel') {
        fireEvent.pointerCancel(svg, { pointerId: 7 });
      } else {
        fireEvent.lostPointerCapture(svg, { pointerId: 7 });
      }
      expect(rects[0]).toHaveAttribute('x', '10');
      expect(rects[0]).toHaveAttribute('width', '20');
      if (reason !== 'lostpointercapture') {
        expect(release).toHaveBeenCalledWith(7);
      }
      up();
      expect(onMove).not.toHaveBeenCalled();
      expect(onResize).not.toHaveBeenCalled();
      down(rects[0], 8);
      move(5, 0, 8);
      up(8);
      expect(onMove).toHaveBeenCalledExactlyOnceWith(['e1'], 5, 0, 'end');
      expect(onResize).not.toHaveBeenCalled();
    }
  );

  it.each(['pointercancel', 'lostpointercapture'])(
    'ignores %s from another pointer',
    (reason) => {
      const { svg, rects, down, move, up, release, onMove } = canvasFixture();
      down();
      move();
      if (reason === 'pointercancel') {
        fireEvent.pointerCancel(svg, { pointerId: 99 });
      } else {
        fireEvent.lostPointerCapture(svg, { pointerId: 99 });
      }
      expect(rects[0]).toHaveAttribute('x', '20');
      expect(release).not.toHaveBeenCalled();
      move(15, 0);
      up();
      expect(onMove).toHaveBeenCalledExactlyOnceWith(['e1'], 15, 0, 'end');
    }
  );

  it('toggles a selected entity off without dragging the old selection', () => {
    const { rects, move, up, onMove, onSelect, capture } = canvasFixture([
      'e1',
      'e2'
    ]);
    fireEvent.pointerDown(rects[0], {
      button: 0,
      pointerId: 7,
      shiftKey: true
    });
    move();
    up();
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('e1', true);
    expect(capture).not.toHaveBeenCalled();
    expect(onMove).not.toHaveBeenCalled();
  });

  it('cancels when the window loses focus without committing geometry', () => {
    const { down, move, up, onMove, release, rects } = canvasFixture();
    down();
    move();
    fireEvent.blur(window);
    up();
    expect(rects[0]).toHaveAttribute('x', '10');
    expect(release).toHaveBeenCalledExactlyOnceWith(7);
    expect(onMove).not.toHaveBeenCalled();
  });

  it('keeps capture while leaving the canvas and clamps a multi-selection together', () => {
    const { svg, down, move, up, rects, release, onMove } = canvasFixture([
      'e1',
      'e2'
    ]);
    down();
    fireEvent.pointerLeave(svg, { pointerId: 7 });
    expect(release).not.toHaveBeenCalled();
    move(200, 200);
    expect(rects[0]).toHaveAttribute('x', '40');
    expect(rects[1]).toHaveAttribute('x', '80');
    up();
    expect(onMove).toHaveBeenCalledExactlyOnceWith(['e1', 'e2'], 30, 30, 'end');
  });

  it('ignores another pointer down, move and up while dragging', () => {
    const { down, move, up, rects, onMove, capture } = canvasFixture();
    down();
    down(rects[1], 99);
    move(40, 40, 99);
    up(99);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(rects[0]).toHaveAttribute('x', '10');
    move();
    up();
    expect(onMove).toHaveBeenCalledExactlyOnceWith(['e1'], 10, 5, 'end');
  });

  it('anchors wheel zoom at the pointer without consuming ordinary scrolling', () => {
    const { svg, rects, down, move, up, onMove } = canvasFixture();
    const plain = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: 100
    });
    fireEvent(svg, plain);
    expect(plain.defaultPrevented).toBe(false);
    const wheel = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      deltaY: -100,
      clientX: 50,
      clientY: 70
    });
    fireEvent(svg, wheel);
    expect(wheel.defaultPrevented).toBe(true);
    const transform = rects[0]
      .closest('g[transform]')
      ?.getAttribute('transform');
    const numbers = transform?.match(/-?\d+(?:\.\d+)?/g)?.map(Number);
    expect(numbers).toBeDefined();
    expect(numbers?.[0]).toBeCloseTo(-5);
    expect(numbers?.[1]).toBeCloseTo(-7);
    expect(numbers?.[2]).toBeCloseTo(1.1);
    down();
    move(11, 22);
    up();
    expect(onMove).toHaveBeenCalledExactlyOnceWith(['e1'], 10, 20, 'end');
  });

  it('ignores wheel and zoom controls during a drag', () => {
    const { rects, zoom, down, move, up, onMove } = canvasFixture();
    zoom(1);
    const group = rects[0].closest('g[transform]');
    const before = group?.getAttribute('transform');
    down();
    const wheel = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      deltaY: -100
    });
    fireEvent(rects[0], wheel);
    expect(wheel.defaultPrevented).toBe(true);
    zoom(1);
    fireEvent.click(screen.getByLabelText('Zoom in'));
    fireEvent.click(screen.getByLabelText('Zoom out'));
    fireEvent.click(screen.getByLabelText('Reset view'));
    expect(group?.getAttribute('transform')).toBe(before);
    move(11, 0);
    up();
    expect(onMove).toHaveBeenCalledExactlyOnceWith(['e1'], 10, 0, 'end');
  });
});

describe('EditorCanvas navigation', () => {
  it.each([0, -7, 7])('pans by screen pixels at wheel step %i', (steps) => {
    const f = canvasFixture();
    f.zoom(steps);
    const before = readViewport(f.svg);
    startPan(f);
    expect(f.capture).toHaveBeenCalledExactlyOnceWith(7);
    expect(document.activeElement).toBe(f.svg);
    f.move(31, -17);
    expect(readViewport(f.svg)).toEqual({
      ...before,
      offsetX: before.offsetX + 31,
      offsetY: before.offsetY - 17
    });
    f.up();
    expect(f.release).toHaveBeenCalledExactlyOnceWith(7);
    expectNoCanvasMutation(f);
  });

  it.each(['root', 'entity', 'handle'])(
    'middle-pans from %s without editing',
    (target) => {
      const f = canvasFixture(['e1', 'e2']);
      startPan(
        f,
        target === 'root'
          ? f.svg
          : target === 'entity'
            ? f.rects[1]
            : f.handle()
      );
      f.move();
      f.up();
      expect(readViewport(f.svg)).toEqual({ zoom: 1, offsetX: 10, offsetY: 5 });
      expectNoCanvasMutation(f);
    }
  );

  it.each(['root', 'entity', 'handle'])(
    'Space-primary pans from %s and releases readiness without ending pan',
    (target) => {
      const f = canvasFixture();
      const handle = target === 'handle' ? f.handle() : null;
      f.svg.focus();
      expect(fireEvent.keyDown(f.svg, { key: ' ', code: 'Space' })).toBe(false);
      expect(f.svg).toHaveStyle({ cursor: 'grab' });
      startPan(
        f,
        target === 'root'
          ? f.svg
          : target === 'entity'
            ? f.rects[0]
            : (handle as SVGRectElement),
        0
      );
      expect(f.svg).toHaveStyle({ cursor: 'grabbing' });
      f.move(10, 5);
      fireEvent.keyUp(window, { key: ' ', code: 'Space' });
      f.move(25, 15);
      f.up();
      expect(readViewport(f.svg)).toEqual({
        zoom: 1,
        offsetX: 25,
        offsetY: 15
      });
      expect(f.svg).not.toHaveStyle({ cursor: 'grab' });
      expectNoCanvasMutation(f);
      f.down();
      f.move(5, 0);
      f.up();
      expect(f.onMove).toHaveBeenCalledExactlyOnceWith(['e1'], 5, 0, 'end');
      f.down(f.svg);
      expect(f.onClearSelection).toHaveBeenCalledExactlyOnceWith();
    }
  );

  it.each(['input', 'textarea', 'contenteditable', 'window'])(
    'does not arm Space pan while typing in %s',
    (kind) => {
      const f = canvasFixture();
      const control = document.createElement(
        kind === 'textarea' ? 'textarea' : kind === 'input' ? 'input' : 'div'
      );
      if (kind === 'contenteditable')
        control.setAttribute('contenteditable', 'true');
      document.body.append(control);
      control.focus();
      try {
        expect(
          fireEvent.keyDown(kind === 'window' ? window : control, {
            key: ' ',
            code: 'Space'
          })
        ).toBe(true);
        f.down();
        f.move();
        f.up();
        expect(readViewport(f.svg)).toEqual({
          zoom: 1,
          offsetX: 0,
          offsetY: 0
        });
        expect(f.onMove).toHaveBeenCalledExactlyOnceWith(['e1'], 10, 5, 'end');
      } finally {
        control.remove();
      }
    }
  );

  it.each(['keyup', 'SVG blur', 'window blur'])(
    '%s clears idle Space readiness so primary drag edits again',
    (reason) => {
      const f = canvasFixture();
      f.svg.focus();
      fireEvent.keyDown(f.svg, { key: ' ', code: 'Space' });
      expect(f.svg).toHaveStyle({ cursor: 'grab' });
      if (reason === 'keyup')
        fireEvent.keyUp(window, { key: ' ', code: 'Space' });
      else fireEvent.blur(reason === 'SVG blur' ? f.svg : window);
      expect(f.svg).not.toHaveStyle({ cursor: 'grab' });
      f.down();
      f.move();
      f.up();
      expect(readViewport(f.svg)).toEqual({ zoom: 1, offsetX: 0, offsetY: 0 });
      expect(f.onMove).toHaveBeenCalledExactlyOnceWith(['e1'], 10, 5, 'end');
      expect(f.onResize).not.toHaveBeenCalled();
    }
  );

  it('does not let middle-button pan replace an active entity edit', () => {
    const f = canvasFixture();
    f.down();
    f.move(5, 0);
    fireEvent.pointerDown(f.svg, {
      button: 1,
      pointerId: 99,
      clientX: 20,
      clientY: 20
    });
    f.move(50, 50, 99);
    f.up(99);
    expect(readViewport(f.svg)).toEqual({ zoom: 1, offsetX: 0, offsetY: 0 });
    expect(f.capture).toHaveBeenCalledExactlyOnceWith(7);
    f.move(10, 5);
    f.up();
    expect(f.onMove).toHaveBeenCalledExactlyOnceWith(['e1'], 10, 5, 'end');
    expect(f.onResize).not.toHaveBeenCalled();
    expect(f.onSelect).not.toHaveBeenCalled();
    expect(f.onClearSelection).not.toHaveBeenCalled();
  });

  it('SVG blur clears readiness but does not cancel an active pan', () => {
    const f = canvasFixture();
    f.svg.focus();
    fireEvent.keyDown(f.svg, { key: ' ', code: 'Space' });
    startPan(f, f.svg, 0);
    f.move();
    fireEvent.blur(f.svg);
    f.move(25, 15);
    f.up();
    expect(readViewport(f.svg)).toEqual({ zoom: 1, offsetX: 25, offsetY: 15 });
    expectNoCanvasMutation(f);
    f.down();
    f.move(5, 0);
    f.up();
    expect(f.onMove).toHaveBeenCalledExactlyOnceWith(['e1'], 5, 0, 'end');
  });

  it('ignores competing pointers and unrelated cancellation during pan', () => {
    const f = canvasFixture();
    startPan(f);
    f.down(f.rects[1], 99);
    f.move(80, 80, 99);
    f.up(99);
    fireEvent.pointerCancel(f.svg, { pointerId: 99 });
    fireEvent.lostPointerCapture(f.svg, { pointerId: 99 });
    expect(readViewport(f.svg)).toEqual({ zoom: 1, offsetX: 0, offsetY: 0 });
    expect(f.capture).toHaveBeenCalledExactlyOnceWith(7);
    expect(f.release).not.toHaveBeenCalled();
    f.move(15, 25);
    f.up();
    expect(readViewport(f.svg)).toEqual({ zoom: 1, offsetX: 15, offsetY: 25 });
    expect(f.release).toHaveBeenCalledExactlyOnceWith(7);
    expectNoCanvasMutation(f);
  });

  it.each(['Escape', 'pointercancel', 'lostpointercapture', 'blur'])(
    'restores the pre-pan viewport on %s after prior pan and zoom',
    (reason) => {
      const f = canvasFixture();
      startPan(f);
      f.move(30, -10);
      f.up();
      f.zoom(3);
      const before = readViewport(f.svg);
      f.release.mockClear();
      f.svg.focus();
      fireEvent.keyDown(f.svg, { key: ' ', code: 'Space' });
      startPan(f, f.rects[0], 0);
      f.move(40, 60);
      expect(readViewport(f.svg)).not.toEqual(before);
      if (reason === 'Escape') fireEvent.keyDown(window, { key: 'Escape' });
      else if (reason === 'pointercancel')
        fireEvent.pointerCancel(f.svg, { pointerId: 7 });
      else if (reason === 'lostpointercapture')
        fireEvent.lostPointerCapture(f.svg, { pointerId: 7 });
      else fireEvent.blur(window);
      expect(readViewport(f.svg)).toEqual(before);
      if (reason !== 'lostpointercapture')
        expect(f.release).toHaveBeenCalledWith(7);
      f.up();
      expectNoCanvasMutation(f);
      fireEvent.keyUp(window, { key: ' ', code: 'Space' });
      f.down();
      f.move(5 * before.zoom, 0);
      f.up();
      expect(f.onMove).toHaveBeenCalledExactlyOnceWith(['e1'], 5, 0, 'end');
    }
  );

  it('uses current refs for consecutive pan moves/up before rerender and survives a parent rerender', () => {
    const f = canvasFixture();
    act(() => {
      startPan(f);
      f.move(10, 5);
      f.move(30, 15);
      f.up();
    });
    expect(readViewport(f.svg)).toEqual({ zoom: 1, offsetX: 30, offsetY: 15 });
    f.rerenderCanvas();
    act(() => {
      startPan(f);
      f.move(-5, 20);
      f.up();
    });
    expect(readViewport(f.svg)).toEqual({ zoom: 1, offsetX: 25, offsetY: 35 });
    expect(f.capture).toHaveBeenCalledTimes(2);
    expect(f.release).toHaveBeenCalledTimes(2);
    expectNoCanvasMutation(f);
    act(() => {
      f.down();
      f.move(5, 0);
      f.move(10, 0);
      f.up();
    });
    expect(f.onMove).toHaveBeenCalledExactlyOnceWith(['e1'], 10, 0, 'end');
  });

  it('prevents middle auxclick without consuming primary click', () => {
    const f = canvasFixture();
    const middle = new MouseEvent('auxclick', {
      bubbles: true,
      cancelable: true,
      button: 1
    });
    fireEvent(f.svg, middle);
    expect(middle.defaultPrevented).toBe(true);
    const primary = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0
    });
    fireEvent(f.svg, primary);
    expect(primary.defaultPrevented).toBe(false);
    f.down(f.svg);
    expect(f.onClearSelection).toHaveBeenCalledTimes(1);
  });

  it('fits measured non-square dimensions with padding and does not refit on rerender', () => {
    const f = canvasFixture(['e1'], { width: 200, height: 100 });
    f.measurement.mockReturnValue({
      ...f.svg.getBoundingClientRect(),
      left: 80,
      top: 40,
      width: 400,
      height: 200
    });
    expect(
      screen.getByRole('button', { name: 'Reset view' })
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Fit to view' }));
    expect(readViewport(f.svg)).toEqual({
      zoom: 1.52,
      offsetX: 48,
      offsetY: 24
    });
    f.rerenderCanvas({ width: 300, height: 150 });
    expect(readViewport(f.svg)).toEqual({
      zoom: 1.52,
      offsetX: 48,
      offsetY: 24
    });
    expectNoCanvasMutation(f);
    fireEvent.click(screen.getByLabelText('Reset view'));
    expect(readViewport(f.svg)).toEqual({ zoom: 1, offsetX: 0, offsetY: 0 });
  });

  it('fits the default 100px measurement at .52', () => {
    const f = canvasFixture();
    fireEvent.click(screen.getByRole('button', { name: 'Fit to view' }));
    expect(readViewport(f.svg)).toEqual({
      zoom: 0.52,
      offsetX: 24,
      offsetY: 24
    });
    expectNoCanvasMutation(f);
  });

  it.each([
    [10000, 10000, 0.1],
    [1, 1, 20]
  ])('clamps fit for bounds %ix%i', (width, height, zoom) => {
    const f = canvasFixture(['e1'], { width, height });
    fireEvent.click(screen.getByLabelText('Fit to view'));
    expect(readViewport(f.svg)).toEqual({
      zoom,
      offsetX: (100 - width * zoom) / 2,
      offsetY: (100 - height * zoom) / 2
    });
    expectNoCanvasMutation(f);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'ignores invalid fit measurements and bounds: %s',
    (invalid) => {
      const f = canvasFixture();
      startPan(f);
      f.move(20, 10);
      f.up();
      f.zoom(2);
      const before = readViewport(f.svg);
      const rect = f.svg.getBoundingClientRect();
      for (const axis of ['width', 'height'] as const) {
        f.measurement.mockReturnValue({ ...rect, [axis]: invalid });
        for (const label of ['Fit to view', 'Zoom in', 'Zoom out']) {
          fireEvent.click(screen.getByLabelText(label));
          expect(readViewport(f.svg)).toEqual(before);
        }
        f.measurement.mockReturnValue(rect);
        f.rerenderCanvas({ width: 100, height: 100, [axis]: invalid });
        fireEvent.click(screen.getByLabelText('Fit to view'));
        expect(readViewport(f.svg)).toEqual(before);
        f.rerenderCanvas();
      }
      for (const axis of ['width', 'height'] as const) {
        f.measurement.mockReturnValue({ ...rect, [axis]: invalid });
        fireEvent.click(screen.getByLabelText('Reset view'));
        expect(readViewport(f.svg)).toEqual({
          zoom: 1,
          offsetX: 0,
          offsetY: 0
        });
      }
      expectNoCanvasMutation(f);
    }
  );

  it.each(['pan', 'fit'])(
    'anchors toolbar zoom at the measured centre after %s',
    (setup) => {
      const f = canvasFixture();
      f.measurement.mockReturnValue({
        ...f.svg.getBoundingClientRect(),
        left: 80,
        top: 40,
        width: 320,
        height: 180
      });
      if (setup === 'pan') {
        startPan(f);
        f.move(27, -13);
        f.up();
      } else fireEvent.click(screen.getByLabelText('Fit to view'));
      const before = readViewport(f.svg);
      const centre = {
        x: (160 - before.offsetX) / before.zoom,
        y: (90 - before.offsetY) / before.zoom
      };
      for (const label of ['Zoom in', 'Zoom out']) {
        fireEvent.click(screen.getByLabelText(label));
        const current = readViewport(f.svg);
        expect((160 - current.offsetX) / current.zoom).toBeCloseTo(centre.x);
        expect((90 - current.offsetY) / current.zoom).toBeCloseTo(centre.y);
        if (label === 'Zoom in')
          expect(current.zoom).toBeGreaterThan(before.zoom);
      }
      expectNoCanvasMutation(f);
    }
  );

  it.each([
    ['Zoom in', 20],
    ['Zoom out', 0.1]
  ] as const)('does not drift at the %s limit', (label, limit) => {
    const f = canvasFixture();
    startPan(f);
    f.move(27, -13);
    f.up();
    for (let i = 0; i < 100; i++) fireEvent.click(screen.getByLabelText(label));
    const before = readViewport(f.svg);
    expect(before.zoom).toBe(limit);
    for (let i = 0; i < 5; i++) fireEvent.click(screen.getByLabelText(label));
    expect(readViewport(f.svg)).toEqual(before);
    expectNoCanvasMutation(f);
  });

  it.each(['ctrlKey', 'metaKey'])(
    'preserves %s wheel anchoring after pan',
    (modifier) => {
      const f = canvasFixture();
      f.measurement.mockReturnValue({
        ...f.svg.getBoundingClientRect(),
        left: 30,
        top: 40
      });
      startPan(f);
      f.move(25, -10);
      f.up();
      const before = readViewport(f.svg);
      const wheel = new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        [modifier]: true,
        deltaY: -100,
        clientX: 80,
        clientY: 110
      });
      fireEvent(f.svg, wheel);
      expect(wheel.defaultPrevented).toBe(true);
      const after = readViewport(f.svg);
      expect(after.zoom).toBeCloseTo(before.zoom * 1.1);
      expect((50 - after.offsetX) / after.zoom).toBeCloseTo(
        (50 - before.offsetX) / before.zoom
      );
      expect((70 - after.offsetY) / after.zoom).toBeCloseTo(
        (70 - before.offsetY) / before.zoom
      );
      const plain = new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaY: 100
      });
      fireEvent(f.svg, plain);
      expect(plain.defaultPrevented).toBe(false);
      expect(readViewport(f.svg)).toEqual(after);
      expectNoCanvasMutation(f);
    }
  );

  it.each(['pan', 'move', 'resize'])(
    'keeps all navigation controls inert during %s, including before rerender',
    (kind) => {
      const f = canvasFixture();
      f.zoom(1);
      const before = readViewport(f.svg);
      act(() => {
        if (kind === 'pan') startPan(f);
        else f.down(kind === 'resize' ? f.handle() : f.rects[0]);
        for (const label of [
          'Zoom in',
          'Zoom out',
          'Fit to view',
          'Reset view'
        ])
          fireEvent.click(screen.getByLabelText(label));
        const wheel = new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          deltaY: -100
        });
        fireEvent(f.svg, wheel);
        expect(wheel.defaultPrevented).toBe(true);
      });
      expect(readViewport(f.svg)).toEqual(before);
      // Once React has rendered the active gesture, the guards must still hold.
      for (const label of ['Zoom in', 'Zoom out', 'Fit to view', 'Reset view'])
        fireEvent.click(screen.getByLabelText(label));
      expect(readViewport(f.svg)).toEqual(before);
      f.up();
      expectNoCanvasMutation(f);
    }
  );
});

describe('EditorCanvas', () => {
  it('commits a pointer drag as a single move command', () => {
    const onMove = vi.fn();
    const { container } = wrap(
      <EditorCanvas
        bounds={{ width: 100, height: 100 }}
        entities={[entity]}
        selection={[]}
        grid={1}
        snap
        ariaLabel='test canvas'
        onSelect={vi.fn()}
        onMove={onMove}
        onResize={vi.fn()}
      />
    );

    const rect = container.querySelector('rect[style*="move"]');
    expect(rect).not.toBeNull();

    fireEvent.pointerDown(rect as Element, {
      button: 0,
      clientX: 10,
      clientY: 10,
      pointerId: 1
    });
    fireEvent.pointerMove(rect as Element, {
      clientX: 30,
      clientY: 10,
      pointerId: 1
    });
    fireEvent.pointerUp(rect as Element, { pointerId: 1 });

    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove.mock.calls[0][0]).toEqual(['e1']);
    expect(onMove.mock.calls[0][1]).toBe(20);
    expect(onMove.mock.calls[0][2]).toBe(0);
  });

  it('supports the keyboard equivalent for moving the selection', () => {
    const onMove = vi.fn();
    wrap(
      <EditorCanvas
        bounds={{ width: 100, height: 100 }}
        entities={[entity]}
        selection={['e1']}
        grid={5}
        snap
        ariaLabel='keyboard canvas'
        onSelect={vi.fn()}
        onMove={onMove}
        onResize={vi.fn()}
      />
    );

    const svg = screen.getByRole('application', { name: 'keyboard canvas' });
    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    expect(onMove).toHaveBeenCalledWith(['e1'], 5, 0, 'end');

    fireEvent.keyDown(svg, { key: 'ArrowUp', shiftKey: true });
    expect(onMove).toHaveBeenCalledWith(['e1'], 0, -50, 'end');
  });

  it('exposes zoom controls with accessible names', () => {
    wrap(
      <EditorCanvas
        bounds={{ width: 100, height: 100 }}
        entities={[]}
        selection={[]}
        ariaLabel='zoom canvas'
        onSelect={vi.fn()}
        onMove={vi.fn()}
        onResize={vi.fn()}
      />
    );
    expect(screen.getByLabelText('Zoom in')).toBeInTheDocument();
    expect(screen.getByLabelText('Zoom out')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Fit to view' })
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Reset view')).toBeInTheDocument();
  });
});

describe('EditorCanvas archived read-only geometry', () => {
  const active = {
    id: 'active',
    label: 'Active',
    rect: { x: 10, y: 10, width: 20, height: 20 }
  };
  const ghost = {
    id: 'ghost',
    label: 'Ghost',
    rect: { x: 70, y: 10, width: 20, height: 20 },
    archived: true
  };

  it('hides resize handles for a selected archived entity but keeps it visible', () => {
    const { container, rects } = canvasFixture(
      ['ghost'],
      { width: 100, height: 100 },
      [ghost]
    );
    expect(rects).toHaveLength(1);
    expect(container.querySelectorAll('rect[style*="resize"]')).toHaveLength(0);
    // Archived geometry and dashed styling are preserved for inspection.
    expect(rects[0]).toHaveAttribute('x', '70');
    expect(rects[0]).toHaveAttribute('stroke-dasharray');
  });

  it('keeps resize handles for a selected active entity', () => {
    const { container } = canvasFixture(
      ['active'],
      { width: 100, height: 100 },
      [active]
    );
    expect(container.querySelectorAll('rect[style*="resize"]')).toHaveLength(8);
  });

  it('moves only the active entity in a mixed selection without over-clamping', () => {
    const { rects, down, move, up, onMove, onResize } = canvasFixture(
      ['active', 'ghost'],
      { width: 100, height: 100 },
      [active, ghost]
    );

    down(rects[0]);
    move(40, 0);
    // The archived neighbour sits against the right edge; it must neither clamp
    // the active entity's movement nor move itself.
    expect(rects[0]).toHaveAttribute('x', '50');
    expect(rects[1]).toHaveAttribute('x', '70');
    up();

    expect(onMove).toHaveBeenCalledExactlyOnceWith(['active'], 40, 0, 'end');
    expect(onResize).not.toHaveBeenCalled();
  });

  it('leaves an archived-only selection inert when dragged', () => {
    const { rects, down, move, up, onMove, onResize } = canvasFixture(
      ['ghost'],
      { width: 100, height: 100 },
      [ghost]
    );

    down(rects[0]);
    move(30, 30);
    expect(rects[0]).toHaveAttribute('x', '70');
    expect(rects[0]).toHaveAttribute('y', '10');
    up();

    expect(onMove).not.toHaveBeenCalled();
    expect(onResize).not.toHaveBeenCalled();
  });
});

describe('canvas navigation and designer state', () => {
  it('preserves geometry, selection, dirty state and undo/redo history', async () => {
    const cabinet = {
      id: 'navigation-cabinet',
      name: 'Navigation cabinet',
      slug: 'navigation',
      location: 41,
      width_units: 600,
      height_units: 800,
      revision: 3,
      archived: false,
      active_mapping: null
    };
    const drawer = {
      id: 'navigation-drawer',
      label: 'D1',
      display_number: 1,
      location: 42,
      x: 10,
      y: 10,
      width: 60,
      height: 40,
      interior_width: 60,
      interior_height: 40,
      archived: false,
      allocation: null
    };
    const layout = { schema_version: 1, cabinet, drawers: [drawer], bins: [] };
    const api = {
      get: vi.fn(async (url: string) => ({
        data: url.includes('/electrical/')
          ? { cabinet, controllers: [] }
          : layout,
        headers: { etag: '"3"' }
      })),
      post: vi.fn(),
      put: vi.fn(),
      patch: vi.fn()
    };
    wrap(
      <CabinetDesigner
        context={
          { api, navigate: vi.fn() } as unknown as InvenTreePluginContext
        }
        cabinetId={cabinet.id}
      />
    );
    await screen.findByTestId('cabinet-designer');
    const svg = screen.getByRole('application', { name: 'Cabinet front view' });
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      x: 0,
      y: 0,
      width: 1000,
      height: 600,
      right: 1000,
      bottom: 600,
      toJSON: () => ({})
    });
    const selected = screen.getByRole('button', { name: 'Drawer D1' });
    fireEvent.click(selected);
    const rect = svg.querySelector('rect[style*="move"]');
    const navigate = () => {
      for (const label of [
        'Zoom in',
        'Zoom out',
        'Fit to view',
        'Reset view'
      ]) {
        fireEvent.click(screen.getByLabelText(label));
        expect(selected).toHaveAttribute('aria-selected', 'true');
        expect(rect).toHaveAttribute('width', '60');
        expect(rect).toHaveAttribute('height', '40');
        expect(rect).toHaveAttribute('y', '10');
      }
    };
    navigate();
    expect(rect).toHaveAttribute('x', '10');
    expect(screen.getByText('Saved', { exact: true })).toBeVisible();
    expect(screen.getByLabelText('Undo')).toBeDisabled();
    expect(screen.getByLabelText('Redo')).toBeDisabled();

    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    navigate();
    expect(rect).toHaveAttribute('x', '20');
    expect(screen.getByText('Unsaved changes')).toBeVisible();
    expect(screen.getByLabelText('Undo')).toBeEnabled();
    expect(screen.getByLabelText('Redo')).toBeDisabled();

    fireEvent.click(screen.getByLabelText('Undo'));
    // Existing editor semantics keep the draft dirty after undo until save/revert.
    expect(screen.getByText('Unsaved changes')).toBeVisible();
    navigate();
    expect(rect).toHaveAttribute('x', '10');
    expect(screen.getByText('Unsaved changes')).toBeVisible();
    expect(screen.getByLabelText('Undo')).toBeDisabled();
    expect(screen.getByLabelText('Redo')).toBeEnabled();
    fireEvent.click(screen.getByLabelText('Redo'));
    expect(rect).toHaveAttribute('x', '20');
    expect(api.put).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
    expect(api.patch).not.toHaveBeenCalled();
    expect(layout.drawers).toEqual([drawer]);
  });
});

describe('DrawerInspector', () => {
  it('shows the LED count and allocates a range', () => {
    const onAllocate = vi.fn();
    wrap(
      <DrawerInspector
        drawer={{
          id: 'd1',
          label: 'A1',
          display_number: 1,
          location: 41,
          x: 0,
          y: 0,
          width: 100,
          height: 50,
          interior_width: 90,
          interior_height: 40,
          archived: false,
          allocation: { logical_start: 45, logical_end: 75 }
        }}
        totalPixels={120}
        readOnly={false}
        onField={vi.fn()}
        onAllocate={onAllocate}
      />
    );
    expect(screen.getByText(/31 LEDs/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Clear allocation'));
    expect(onAllocate).toHaveBeenCalledWith(null, null);
  });

  it('explains that a mapping is required before allocation', () => {
    wrap(
      <DrawerInspector
        drawer={{
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
          allocation: null
        }}
        totalPixels={0}
        readOnly={false}
        onField={vi.fn()}
        onAllocate={vi.fn()}
      />
    );
    expect(screen.getByText(/Publish a complete mapping/i)).toBeInTheDocument();
    expect(screen.getByText(/Unbound/i)).toBeInTheDocument();
  });
});

describe('EditorToolbar', () => {
  it('disables mutation actions in read-only mode', () => {
    wrap(
      <EditorToolbar
        readOnly
        dirty={false}
        saving={false}
        canUndo={false}
        canRedo={false}
        snap
        grid={10}
        onToggleSnap={vi.fn()}
        onGridChange={vi.fn()}
        onAdd={vi.fn()}
        addLabel='Add drawer'
        onDuplicate={vi.fn()}
        duplicateDisabled={false}
        onArchive={vi.fn()}
        archiveLabel='Archive'
        archiveDisabled={false}
        onUndo={vi.fn()}
        onRedo={vi.fn()}
        onValidate={vi.fn()}
        onSave={vi.fn()}
        onRevert={vi.fn()}
      />
    );
    expect(screen.getByLabelText('Add drawer')).toBeDisabled();
    expect(screen.getByLabelText('Save layout')).toBeDisabled();
    // Validation is always available.
    expect(screen.getByLabelText('Validate layout')).not.toBeDisabled();
  });
});

describe('ValidationPanel', () => {
  it('lists blocking errors and warnings with codes', () => {
    const onSelect = vi.fn();
    wrap(
      <ValidationPanel
        report={{
          errors: [
            {
              code: 'geometry_overlap',
              severity: 'error',
              message: 'Drawers A and B overlap',
              related_ids: ['a', 'b']
            }
          ],
          warnings: [
            {
              code: 'unbound_bin',
              severity: 'warning',
              message: 'Bin is unbound',
              related_ids: ['x']
            }
          ]
        }}
        onSelectEntity={onSelect}
      />
    );
    expect(screen.getByText('Layout cannot be saved')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/error: Drawers A and B overlap/));
    expect(onSelect).toHaveBeenCalledWith(['a', 'b']);
    expect(screen.getByText('unbound_bin')).toBeInTheDocument();
  });
});
