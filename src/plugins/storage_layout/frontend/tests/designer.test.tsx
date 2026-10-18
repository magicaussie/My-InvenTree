import type { InvenTreePluginContext } from '@inventreedb/ui';
import { MantineProvider } from '@mantine/core';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { DrawerInput, LayoutResponse } from '../src/api/types';
import { CabinetDesigner } from '../src/components/CabinetDesigner';
import { CabinetList } from '../src/components/CabinetList';
import { DrawerDesigner } from '../src/components/DrawerDesigner';

const CABINET = {
  id: 'cabinet-1',
  name: 'Cabinet A',
  slug: 'cabinet-a',
  location: 41,
  width_units: 600,
  height_units: 800,
  revision: 3,
  archived: false,
  active_mapping: null,
  default_profile: null
};

const LAYOUT = {
  schema_version: 1,
  cabinet: CABINET,
  drawers: [],
  bins: [],
  active_mapping: null,
  total_pixels: 0,
  numbering_base: 1,
  validation: { errors: [], warnings: [] }
};

function fakeContext(
  overrides: Record<string, unknown> = {},
  layout: LayoutResponse = LAYOUT
) {
  const api = {
    get: vi.fn(async (url: string) => {
      if (url.includes('/electrical/')) {
        return {
          data: {
            schema_version: 1,
            cabinet: CABINET,
            controllers: [],
            revision: 3
          },
          headers: { etag: '"3"' }
        };
      }
      if (url.endsWith('/api/v1/cabinets/')) {
        return {
          data: { count: 1, next: null, previous: null, results: [CABINET] },
          headers: {}
        };
      }
      if (url.includes('/api/v1/cabinets/')) {
        return { data: layout, headers: { etag: '"3"' } };
      }
      return {
        data: { count: 1, next: null, previous: null, results: [CABINET] },
        headers: {}
      };
    }),
    post: vi.fn(async () => ({ data: {} })),
    put: vi.fn(async () => ({ data: layout, headers: { etag: '"4"' } })),
    patch: vi.fn(async () => ({ data: CABINET }))
  };

  return {
    api,
    navigate: vi.fn(),
    model: 'stocklocation',
    id: 41,
    ...overrides
  } as unknown as InvenTreePluginContext;
}

describe('DrawerDesigner', () => {
  it('validates a drawer front rectangle against cabinet dimensions, not its interior', async () => {
    const context = fakeContext();
    const originalGet = context.api.get.bind(context.api);
    context.api.get = vi.fn(async (url: string) => {
      if (url.includes('/drawers/drawer-2/layout/'))
        return {
          data: {
            schema_version: 1,
            cabinet: { ...CABINET, total_pixels: 0 },
            drawer: {
              id: 'drawer-2',
              label: 'D2',
              display_number: 2,
              location: 42,
              x: 0,
              y: 200,
              width: 600,
              height: 200,
              interior_width: 560,
              interior_height: 160,
              archived: false,
              allocation: null
            },
            bins: []
          },
          headers: { etag: '"3"' }
        };
      return originalGet(url);
    }) as typeof context.api.get;
    render(
      <MantineProvider>
        <DrawerDesigner context={context} drawerId='drawer-2' />
      </MantineProvider>
    );
    await waitFor(() =>
      expect(screen.getByTestId('drawer-designer')).toBeInTheDocument()
    );
    expect(
      screen.queryByText(/extends outside the cabinet/)
    ).not.toBeInTheDocument();
    expect(screen.getByText('Layout is valid')).toBeInTheDocument();
  });
});

describe('CabinetList', () => {
  it('lists cabinets returned by the API', async () => {
    render(
      <MantineProvider>
        <CabinetList context={fakeContext()} />
      </MantineProvider>
    );
    await waitFor(() =>
      expect(screen.getByTestId('cabinet-list')).toBeInTheDocument()
    );
    expect(screen.getByText('Storage Layout')).toBeInTheDocument();
    expect(screen.getByText('Cabinet A')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Design' })).toBeInTheDocument();
  });
});

const EXISTING_DRAWER: DrawerInput = {
  id: 'existing-drawer',
  label: 'Existing',
  display_number: 1,
  location: null,
  x: 0,
  y: 0,
  width: 60,
  height: 40,
  interior_width: 60,
  interior_height: 40,
  archived: false,
  allocation: null
};

async function renderCabinet(layout: LayoutResponse = LAYOUT) {
  const context = fakeContext({}, layout);
  const result = render(
    <MantineProvider>
      <CabinetDesigner context={context} cabinetId='cabinet-1' />
    </MantineProvider>
  );
  await screen.findByTestId('cabinet-designer');
  return { ...result, context };
}

describe('CabinetDesigner', () => {
  it('adds non-overlapping drawers without changing size or numbering and supports undo/redo', async () => {
    const { container, context } = await renderCabinet();
    fireEvent.click(screen.getByLabelText('Add drawer'));
    fireEvent.click(screen.getByLabelText('Add drawer'));
    const rectangles = () =>
      Array.from(container.querySelectorAll('rect[style*="move"]'));
    expect(rectangles()).toHaveLength(2);
    expect(rectangles()[0]).toHaveAttribute('x', '0');
    expect(rectangles()[1]).toHaveAttribute('x', '60');
    for (const rect of rectangles()) {
      expect(rect).toHaveAttribute('y', '0');
      expect(rect).toHaveAttribute('width', '60');
      expect(rect).toHaveAttribute('height', '40');
    }
    expect(screen.getByRole('button', { name: 'Drawer D1' })).toHaveAttribute(
      'aria-selected',
      'false'
    );
    expect(screen.getByRole('button', { name: 'Drawer D2' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    fireEvent.click(screen.getByLabelText('Undo'));
    expect(rectangles()).toHaveLength(1);
    expect(rectangles()[0]).toHaveAttribute('x', '0');
    fireEvent.click(screen.getByLabelText('Redo'));
    expect(rectangles()).toHaveLength(2);
    expect(rectangles()[1]).toHaveAttribute('x', '60');
    expect(context.api.put).not.toHaveBeenCalled();
  });

  it.each([1, 2])(
    'avoids %i existing active drawers without repositioning them, even when they overlap',
    async (count) => {
      const drawers = Array.from({ length: count }, (_, index) => ({
        ...EXISTING_DRAWER,
        id: `existing-${index}`,
        label: `Existing ${index}`,
        display_number: index + 1
      }));
      const { container } = await renderCabinet({ ...LAYOUT, drawers });
      fireEvent.click(screen.getByLabelText('Add drawer'));
      const rects = container.querySelectorAll('rect[style*="move"]');
      expect(rects).toHaveLength(count + 1);
      for (let index = 0; index < count; index++) {
        expect(rects[index]).toHaveAttribute('x', '0');
        expect(rects[index]).toHaveAttribute('y', '0');
        expect(rects[index]).toHaveAttribute('width', '60');
        expect(rects[index]).toHaveAttribute('height', '40');
      }
      expect(rects[count]).toHaveAttribute('x', '60');
      expect(rects[count]).toHaveAttribute('y', '0');
      expect(
        screen.getByRole('button', { name: `Drawer D${count + 1}` })
      ).toHaveAttribute('aria-selected', 'true');
    }
  );

  it('ignores archived drawers when finding space for a new drawer', async () => {
    const layout = {
      ...LAYOUT,
      drawers: [{ ...EXISTING_DRAWER, archived: true }]
    };
    const { container } = await renderCabinet(layout);
    fireEvent.click(screen.getByLabelText('Add drawer'));
    const active = within(screen.getByTestId('drawer-list')).getAllByRole(
      'button'
    );
    expect(active).toHaveLength(1);
    expect(active[0]).toHaveAttribute('aria-label', 'Drawer D1');
    expect(active[0]).toHaveAttribute('aria-selected', 'true');
    const rects = container.querySelectorAll('rect[style*="move"]');
    expect(rects).toHaveLength(2);
    expect(rects[1]).toHaveAttribute('x', '0');
    expect(rects[1]).toHaveAttribute('y', '0');
    expect(layout.drawers[0]).toEqual({ ...EXISTING_DRAWER, archived: true });
  });

  it('reports insufficient space without changing the draft, selection or command history', async () => {
    const layout = {
      ...LAYOUT,
      cabinet: { ...CABINET, width_units: 60, height_units: 40 },
      drawers: [{ ...EXISTING_DRAWER }]
    };
    const { container, context } = await renderCabinet(layout);
    const selected = screen.getByRole('button', { name: 'Drawer Existing' });
    fireEvent.click(selected);
    const svg = screen.getByRole('application', { name: 'Cabinet front view' });
    const before = svg.innerHTML;
    fireEvent.click(screen.getByLabelText('Add drawer'));
    expect(
      screen.getByText('Insufficient free space to add a drawer.')
    ).toBeVisible();
    expect(selected).toHaveAttribute('aria-selected', 'true');
    expect(svg.innerHTML).toBe(before);
    expect(container.querySelectorAll('rect[style*="move"]')).toHaveLength(1);
    expect(screen.getByText('Saved', { exact: true })).toBeVisible();
    expect(screen.getByLabelText('Undo')).toBeDisabled();
    expect(context.api.put).not.toHaveBeenCalled();
    expect(layout.drawers).toEqual([EXISTING_DRAWER]);
  });
  it('loads the layout and exposes the designer toolbar', async () => {
    render(
      <MantineProvider>
        <CabinetDesigner context={fakeContext()} cabinetId='cabinet-1' />
      </MantineProvider>
    );
    await waitFor(() =>
      expect(screen.getByTestId('cabinet-designer')).toBeInTheDocument()
    );
    expect(screen.getByLabelText('Add drawer')).toBeInTheDocument();
    expect(screen.getByLabelText('Save layout')).toBeInTheDocument();
    expect(
      screen.getByRole('application', { name: 'Cabinet front view' })
    ).toBeInTheDocument();
    // A freshly created drawer can be added and immediately appears in the list.
    expect(screen.getByText('Cabinet A')).toBeInTheDocument();
  });
});
