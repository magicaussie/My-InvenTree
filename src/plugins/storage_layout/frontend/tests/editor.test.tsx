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
