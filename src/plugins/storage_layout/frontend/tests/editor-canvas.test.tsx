import { MantineProvider } from '@mantine/core';
import { act, fireEvent, render, screen } from '@testing-library/react';
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
  it('requests fullscreen and restores the workspace when fullscreen ends', async () => {
    const { container } = renderCanvas();
    const workspace = container.querySelector('.mantine-Stack-root');
    if (!workspace) throw new Error('Missing editor workspace');
    const request = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(workspace, 'requestFullscreen', { value: request });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Expand canvas' }));
    });
    expect(request).toHaveBeenCalledOnce();
    try {
      Object.defineProperty(document, 'fullscreenElement', {
        configurable: true,
        value: workspace
      });
      fireEvent(document, new Event('fullscreenchange'));
      expect(
        screen.getByRole('button', { name: 'Exit full viewport' })
      ).toHaveAttribute('aria-pressed', 'true');
      expect(workspace).toHaveStyle({ width: '100%' });
      Object.defineProperty(document, 'fullscreenElement', {
        configurable: true,
        value: null
      });
      fireEvent(document, new Event('fullscreenchange'));
      expect(
        screen.getByRole('button', { name: 'Expand canvas' })
      ).toHaveAttribute('aria-pressed', 'false');
      expect(screen.getByRole('application')).toBeInTheDocument();
    } finally {
      Reflect.deleteProperty(document, 'fullscreenElement');
    }
  });

  it.each(['unavailable', 'denied'])(
    'falls back when fullscreen is %s and exits with Escape',
    async (mode) => {
      const { container } = renderCanvas();
      const workspace = container.querySelector('.mantine-Stack-root');
      if (!workspace) throw new Error('Missing editor workspace');
      const canvas = screen.getByRole('application');
      if (mode === 'denied') {
        Object.defineProperty(workspace, 'requestFullscreen', {
          value: vi.fn().mockRejectedValue(new Error('Denied'))
        });
      }
      const previousOverflow = document.body.style.overflow;
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Expand canvas' }));
      });
      expect(
        screen.getByRole('button', { name: 'Exit full viewport' })
      ).toHaveAttribute('aria-pressed', 'true');
      expect(workspace).toHaveStyle({ position: 'fixed', inset: '0' });
      expect(document.body.style.overflow).toBe('hidden');
      expect(screen.getByRole('application')).toBe(canvas);
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(
        screen.getByRole('button', { name: 'Expand canvas' })
      ).toHaveAttribute('aria-pressed', 'false');
      expect(document.body.style.overflow).toBe(previousOverflow);
      expect(screen.getByRole('application')).toBe(canvas);
    }
  );

  it('exits the fallback with its button and restores scrolling on unmount', async () => {
    const { unmount } = renderCanvas();
    const previousOverflow = document.body.style.overflow;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Expand canvas' }));
    });
    fireEvent.click(screen.getByRole('button', { name: 'Exit full viewport' }));
    expect(document.body.style.overflow).toBe(previousOverflow);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Expand canvas' }));
    });
    unmount();
    expect(document.body.style.overflow).toBe(previousOverflow);
  });
  it('sizes the workspace against the viewport and responds to window resizing', () => {
    const { container } = renderCanvas();
    const workspace = container.querySelector('.mantine-Stack-root');
    expect(workspace).toHaveStyle({ height: `${window.innerHeight - 24}px` });
    const originalHeight = window.innerHeight;
    try {
      Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        value: 1000
      });
      fireEvent(window, new Event('resize'));
      expect(workspace).toHaveStyle({ height: '976px' });
      Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        value: 200
      });
      fireEvent(window, new Event('resize'));
      expect(workspace).toHaveStyle({ height: '320px' });
    } finally {
      Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        value: originalHeight
      });
    }
  });

  it('initially fits, but preserves explicit zoom across resize and unrelated edits', () => {
    const callbacks: ResizeObserverCallback[] = [];
    const OriginalObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        callbacks.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    try {
      const { rerender } = renderCanvas();
      const svg = screen.getByRole('application', { name: 'Cabinet canvas' });
      vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({
        width: 1000,
        height: 700
      } as DOMRect);
      const resize = () =>
        act(() =>
          callbacks.forEach((callback) => {
            callback([], {} as ResizeObserver);
          })
        );
      resize();
      const fitted = svg
        .querySelector('g[transform]')
        ?.getAttribute('transform');
      expect(fitted).not.toBe('translate(0 0) scale(1)');
      fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
      const manual = svg
        .querySelector('g[transform]')
        ?.getAttribute('transform');
      expect(manual).not.toBe(fitted);
      rerender(
        <MantineProvider>
          <EditorCanvas {...props} entities={[...props.entities]} />
        </MantineProvider>
      );
      resize();
      expect(svg.querySelector('g[transform]')?.getAttribute('transform')).toBe(
        manual
      );
      fireEvent.click(screen.getByRole('button', { name: 'Fit to view' }));
      expect(svg.querySelector('g[transform]')?.getAttribute('transform')).toBe(
        fitted
      );
    } finally {
      globalThis.ResizeObserver = OriginalObserver;
    }
  });
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
    fireEvent.click(screen.getByRole('button', { name: 'Draw mode' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Draw mode' }));
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

  it('exposes explicit select, draw and pan modes', () => {
    render(
      <MantineProvider>
        <EditorCanvas {...props} selection={[]} onDraw={vi.fn()} />
      </MantineProvider>
    );
    const select = screen.getByRole('button', { name: 'Select mode' });
    const pan = screen.getByRole('button', { name: 'Pan mode' });
    fireEvent.click(pan);
    expect(pan).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(select);
    expect(select).toHaveAttribute('aria-pressed', 'true');
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
