import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { EditorCanvas } from '../src/components/editor/EditorCanvas';
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

function canvasFixture(selection = ['e1']) {
  const onMove = vi.fn();
  const onResize = vi.fn();
  const onSelect = vi.fn();
  const onClearSelection = vi.fn();
  const second = {
    id: 'e2',
    label: 'A2',
    rect: { x: 50, y: 50, width: 20, height: 20 }
  };
  const { container } = wrap(
    <EditorCanvas
      bounds={{ width: 100, height: 100 }}
      entities={[entity, second]}
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
  const svg = screen.getByRole('application', { name: 'regression canvas' });
  vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({
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
    onClearSelection
  };
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
    expect(screen.getByLabelText('Reset view')).toBeInTheDocument();
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
