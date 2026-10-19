import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { EditorCanvas } from '../src/components/editor/EditorCanvas';

const props = {
  bounds: { width: 600, height: 800 },
  entities: [
    {
      id: 'drawer-1',
      label: 'Drawer 1',
      rect: { x: 20, y: 30, width: 200, height: 100 }
    }
  ],
  selection: ['drawer-1'],
  ariaLabel: 'Cabinet canvas',
  grid: 10,
  onSelect: vi.fn(),
  onMove: vi.fn(),
  onResize: vi.fn()
};

function renderCanvas() {
  return render(
    <MantineProvider>
      <EditorCanvas {...props} />
    </MantineProvider>
  );
}

describe('EditorCanvas', () => {
  it('toggles the rendered grid with an accessible control', () => {
    const { container } = renderCanvas();
    const toggle = screen.getByRole('button', { name: 'Grid' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(container.querySelectorAll('[data-grid-line]')).toHaveLength(142);
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(container.querySelectorAll('[data-grid-line]')).toHaveLength(0);
  });

  it('draws a snapped rectangle by dragging on the empty canvas', () => {
    const onDraw = vi.fn();
    const { container } = render(
      <MantineProvider>
        <EditorCanvas {...props} selection={[]} onDraw={onDraw} />
      </MantineProvider>
    );
    const svg = screen.getByRole('application', { name: 'Cabinet canvas' });
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 600,
      bottom: 800,
      width: 600,
      height: 800,
      toJSON: () => ({})
    } as DOMRect);
    fireEvent.click(screen.getByRole('button', { name: 'Draw drawer' }));
    fireEvent.pointerDown(svg, {
      button: 0,
      pointerId: 1,
      clientX: 25,
      clientY: 35
    });
    fireEvent.pointerMove(svg, {
      button: 0,
      pointerId: 1,
      clientX: 86,
      clientY: 97
    });
    expect(
      container.querySelector('rect[stroke="var(--mantine-color-blue-7)"]')
    ).toBeInTheDocument();
    fireEvent.pointerUp(svg, {
      button: 0,
      pointerId: 1,
      clientX: 86,
      clientY: 97
    });
    expect(onDraw).toHaveBeenCalledWith({
      x: 30,
      y: 40,
      width: 60,
      height: 60
    });
  });

  it('cancels a drawer preview without committing it', () => {
    const onDraw = vi.fn();
    const { container } = render(
      <MantineProvider>
        <EditorCanvas {...props} selection={[]} onDraw={onDraw} />
      </MantineProvider>
    );
    const svg = screen.getByRole('application', { name: 'Cabinet canvas' });
    fireEvent.click(screen.getByRole('button', { name: 'Draw drawer' }));
    expect(svg).toHaveStyle({ cursor: 'crosshair' });
    fireEvent.pointerDown(svg, {
      button: 0,
      pointerId: 2,
      clientX: 25,
      clientY: 35
    });
    fireEvent.pointerMove(svg, {
      button: 0,
      pointerId: 2,
      clientX: 86,
      clientY: 97
    });

    fireEvent.pointerCancel(svg, { pointerId: 2 });

    expect(onDraw).not.toHaveBeenCalled();
    expect(
      container.querySelector('rect[stroke="var(--mantine-color-blue-7)"]')
    ).not.toBeInTheDocument();
  });

  it('renders safely when canvas bounds are infinite', () => {
    const { container } = render(
      <MantineProvider>
        <EditorCanvas {...props} bounds={{ width: Infinity, height: 800 }} />
      </MantineProvider>
    );

    expect(container.querySelector('svg')).toBeInTheDocument();
    expect(container.querySelector('[data-grid-line]')).not.toBeInTheDocument();
    expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
  });

  it('shows selected rectangle measurements in canvas units', () => {
    renderCanvas();
    expect(screen.getByText('200 × 100')).toBeInTheDocument();
    expect(screen.getByText('x 20, y 30')).toBeInTheDocument();
  });
});
