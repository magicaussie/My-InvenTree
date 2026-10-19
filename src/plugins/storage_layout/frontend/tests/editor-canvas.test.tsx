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
