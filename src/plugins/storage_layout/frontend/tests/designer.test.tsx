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

/* ------------------------------------------------------------------ */
/* Duplicate (Checkpoint 002C)                                         */
/* ------------------------------------------------------------------ */

function drawerFixture(overrides: Partial<DrawerInput> = {}): DrawerInput {
  return {
    id: 'drawer',
    label: 'Drawer',
    display_number: 1,
    location: null,
    x: 0,
    y: 0,
    width: 60,
    height: 40,
    interior_width: 60,
    interior_height: 40,
    archived: false,
    allocation: null,
    ...overrides
  };
}

interface RectLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

function entityRects(container: HTMLElement): SVGRectElement[] {
  return Array.from(
    container.querySelectorAll<SVGRectElement>('rect[style*="move"]')
  );
}

function rectOf(element: Element): RectLike {
  return {
    x: Number(element.getAttribute('x')),
    y: Number(element.getAttribute('y')),
    width: Number(element.getAttribute('width')),
    height: Number(element.getAttribute('height'))
  };
}

function overlaps(a: RectLike, b: RectLike): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

function expectNoOverlaps(rects: RectLike[]): void {
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      expect(overlaps(rects[i], rects[j])).toBe(false);
    }
  }
}

const DUPLICATE_MESSAGE =
  'Insufficient free space to duplicate the selected drawers.';

describe('CabinetDesigner duplicate', () => {
  it('duplicates a single drawer into free space without copying its native binding or LEDs', async () => {
    const source = drawerFixture({
      id: 'source',
      label: 'Source',
      display_number: 1,
      location: 42,
      x: 0,
      y: 0,
      width: 60,
      height: 40,
      interior_width: 50,
      interior_height: 30,
      allocation: { logical_start: 1, logical_end: 60 }
    });
    const obstacle = drawerFixture({
      id: 'obstacle',
      label: 'Obstacle',
      display_number: 2,
      x: 60,
      y: 0,
      allocation: { logical_start: 61, logical_end: 120 }
    });
    const layout: LayoutResponse = {
      ...LAYOUT,
      total_pixels: 200,
      drawers: [source, obstacle]
    };
    const { container, context } = await renderCabinet(layout);

    fireEvent.click(screen.getByRole('button', { name: 'Drawer Source' }));
    fireEvent.click(screen.getByLabelText('Duplicate selection'));

    const rects = entityRects(container);
    expect(rects).toHaveLength(3);
    expect(rectOf(rects[0])).toEqual({ x: 0, y: 0, width: 60, height: 40 });
    expect(rectOf(rects[1])).toEqual({ x: 60, y: 0, width: 60, height: 40 });
    // First free grid slot after the two occupied rectangles.
    expect(rectOf(rects[2])).toEqual({ x: 120, y: 0, width: 60, height: 40 });
    expectNoOverlaps(rects.map(rectOf));

    const list = within(screen.getByTestId('drawer-list'));
    expect(list.getByText('3. Source copy')).toBeInTheDocument();
    expect(
      list.getByRole('button', { name: 'Drawer Source copy' })
    ).toHaveAttribute('aria-selected', 'true');
    expect(list.getByRole('button', { name: 'Drawer Source' })).toHaveAttribute(
      'aria-selected',
      'false'
    );

    // The copy is unbound and unlit; interior dimensions come from the source.
    expect(
      screen.getByText(/Unbound: this drawer cannot resolve inventory/)
    ).toBeVisible();
    expect(screen.getByText('Unlit drawer')).toBeVisible();
    expect(
      (screen.getByLabelText('Interior width') as HTMLInputElement).value
    ).toBe('50');
    expect(
      (screen.getByLabelText('Interior depth') as HTMLInputElement).value
    ).toBe('30');

    // Selecting the source shows its binding and LEDs are untouched.
    fireEvent.click(screen.getByRole('button', { name: 'Drawer Source' }));
    expect(
      screen.queryByText(/Unbound: this drawer cannot resolve inventory/)
    ).not.toBeInTheDocument();
    expect(screen.getByText('60 LEDs (1\u201360)')).toBeVisible();

    expect(layout.drawers).toEqual([source, obstacle]);
    expect(context.api.put).not.toHaveBeenCalled();
    expect(context.api.post).not.toHaveBeenCalled();
    expect(context.api.patch).not.toHaveBeenCalled();
  });

  it('duplicates a multi-selection without overlaps and undoes/redoes as one batch', async () => {
    const a = drawerFixture({
      id: 'a',
      label: 'A',
      display_number: 1,
      x: 0,
      y: 0,
      width: 60,
      height: 40
    });
    const b = drawerFixture({
      id: 'b',
      label: 'B',
      display_number: 2,
      x: 0,
      y: 40,
      width: 100,
      height: 60
    });
    const layout: LayoutResponse = { ...LAYOUT, drawers: [a, b] };
    const { container, context } = await renderCabinet(layout);

    fireEvent.click(screen.getByRole('button', { name: 'Drawer A' }));
    fireEvent.click(screen.getByRole('button', { name: 'Drawer B' }), {
      ctrlKey: true
    });
    fireEvent.click(screen.getByLabelText('Duplicate selection'));

    const rects = entityRects(container);
    expect(rects).toHaveLength(4);
    const geometry = rects.map(rectOf);
    expectNoOverlaps(geometry);
    // Originals keep their geometry; copies preserve their source sizes.
    expect(geometry[0]).toEqual({ x: 0, y: 0, width: 60, height: 40 });
    expect(geometry[1]).toEqual({ x: 0, y: 40, width: 100, height: 60 });
    expect(geometry[2]).toEqual({ x: 60, y: 0, width: 60, height: 40 });
    expect(geometry[3]).toEqual({ x: 120, y: 0, width: 100, height: 60 });

    const list = within(screen.getByTestId('drawer-list'));
    expect(list.getByText('3. A copy')).toBeInTheDocument();
    expect(list.getByText('4. B copy')).toBeInTheDocument();
    for (const name of ['Drawer A copy', 'Drawer B copy']) {
      expect(list.getByRole('button', { name })).toHaveAttribute(
        'aria-selected',
        'true'
      );
    }
    expect(list.getByRole('button', { name: 'Drawer A' })).toHaveAttribute(
      'aria-selected',
      'false'
    );

    // One undo removes every copy; one redo restores them with their geometry.
    fireEvent.click(screen.getByLabelText('Undo'));
    expect(entityRects(container)).toHaveLength(2);
    fireEvent.click(screen.getByLabelText('Redo'));
    expect(entityRects(container).map(rectOf)).toEqual(geometry);
    expect(context.api.put).not.toHaveBeenCalled();
  });

  it('fails atomically when there is not enough room and preserves selection and history', async () => {
    const a = drawerFixture({
      id: 'a',
      label: 'A',
      display_number: 1,
      x: 0,
      y: 0,
      width: 60,
      height: 40
    });
    const b = drawerFixture({
      id: 'b',
      label: 'B',
      display_number: 2,
      x: 60,
      y: 0,
      width: 60,
      height: 40
    });
    const layout: LayoutResponse = {
      ...LAYOUT,
      cabinet: { ...CABINET, width_units: 180, height_units: 40 },
      drawers: [a, b]
    };
    const { container, context } = await renderCabinet(layout);

    // Create a copy, then undo it so a redo entry exists before the failure.
    fireEvent.click(screen.getByRole('button', { name: 'Drawer A' }));
    fireEvent.click(screen.getByLabelText('Duplicate selection'));
    expect(entityRects(container)).toHaveLength(3);
    fireEvent.click(screen.getByLabelText('Undo'));
    expect(entityRects(container)).toHaveLength(2);
    expect(screen.getByLabelText('Redo')).toBeEnabled();
    expect(screen.getByLabelText('Undo')).toBeDisabled();

    // Only one of the two copies fits, so the whole operation must fail.
    fireEvent.click(screen.getByRole('button', { name: 'Drawer A' }));
    fireEvent.click(screen.getByRole('button', { name: 'Drawer B' }), {
      ctrlKey: true
    });
    const svg = screen.getByRole('application', { name: 'Cabinet front view' });
    const before = svg.innerHTML;
    fireEvent.click(screen.getByLabelText('Duplicate selection'));

    expect(screen.getByText(DUPLICATE_MESSAGE)).toBeVisible();
    expect(entityRects(container)).toHaveLength(2);
    expect(svg.innerHTML).toBe(before);
    expect(screen.getByRole('button', { name: 'Drawer A' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.getByRole('button', { name: 'Drawer B' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.getByLabelText('Undo')).toBeDisabled();
    expect(screen.getByLabelText('Redo')).toBeEnabled();
    expect(context.api.put).not.toHaveBeenCalled();
    expect(layout.drawers).toEqual([a, b]);
  });

  it('ignores archived drawers when reserving space for a duplicate', async () => {
    const archived = drawerFixture({
      id: 'ghost',
      label: 'Ghost',
      display_number: 1,
      x: 60,
      y: 0,
      archived: true
    });
    const active = drawerFixture({
      id: 'live',
      label: 'Live',
      display_number: 2,
      x: 0,
      y: 0
    });
    const layout: LayoutResponse = { ...LAYOUT, drawers: [archived, active] };
    const { container } = await renderCabinet(layout);

    fireEvent.click(screen.getByRole('button', { name: 'Drawer Live' }));
    fireEvent.click(screen.getByLabelText('Duplicate selection'));

    const rects = entityRects(container);
    expect(rects).toHaveLength(3);
    // The copy reuses the slot held by the archived drawer, proving it is ignored.
    expect(rectOf(rects[2])).toEqual({ x: 60, y: 0, width: 60, height: 40 });
    expect(layout.drawers[0]).toEqual(archived);
  });

  it('does not duplicate an archived drawer that is selected', async () => {
    const archived = drawerFixture({
      id: 'ghost',
      label: 'Ghost',
      display_number: 1,
      archived: true
    });
    const layout: LayoutResponse = { ...LAYOUT, drawers: [archived] };
    const { container, context } = await renderCabinet(layout);

    const svg = screen.getByRole('application', { name: 'Cabinet front view' });
    const rect = svg.querySelector('rect[style*="move"]') as SVGRectElement;
    expect(rect).not.toBeNull();
    fireEvent.pointerDown(rect, {
      button: 0,
      clientX: 0,
      clientY: 0,
      pointerId: 1
    });
    fireEvent.pointerUp(svg, { pointerId: 1 });

    fireEvent.click(screen.getByLabelText('Duplicate selection'));

    expect(entityRects(container)).toHaveLength(1);
    expect(screen.queryByText(DUPLICATE_MESSAGE)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Undo')).toBeDisabled();
    expect(context.api.put).not.toHaveBeenCalled();
  });

  it('allows a duplicate to touch an existing drawer along an edge', async () => {
    const a = drawerFixture({
      id: 'a',
      label: 'A',
      display_number: 1,
      x: 0,
      y: 0,
      width: 60,
      height: 40
    });
    const layout: LayoutResponse = {
      ...LAYOUT,
      cabinet: { ...CABINET, width_units: 120, height_units: 40 },
      drawers: [a]
    };
    const { container } = await renderCabinet(layout);

    fireEvent.click(screen.getByRole('button', { name: 'Drawer A' }));
    fireEvent.click(screen.getByLabelText('Duplicate selection'));

    const rects = entityRects(container);
    expect(rects).toHaveLength(2);
    expect(rectOf(rects[1])).toEqual({ x: 60, y: 0, width: 60, height: 40 });
    expectNoOverlaps(rects.map(rectOf));
  });

  it('respects off-grid existing obstacles when placing a duplicate', async () => {
    const a = drawerFixture({
      id: 'a',
      label: 'A',
      display_number: 1,
      x: 5,
      y: 5,
      width: 60,
      height: 40
    });
    const layout: LayoutResponse = { ...LAYOUT, drawers: [a] };
    const { container } = await renderCabinet(layout);

    fireEvent.click(screen.getByRole('button', { name: 'Drawer A' }));
    fireEvent.click(screen.getByLabelText('Duplicate selection'));

    const rects = entityRects(container);
    expect(rects).toHaveLength(2);
    expect(rectOf(rects[1])).toEqual({ x: 70, y: 0, width: 60, height: 40 });
    expectNoOverlaps(rects.map(rectOf));
  });

  it.each([
    {
      name: 'a full cabinet',
      cabinet: { width_units: 60, height_units: 40 },
      drawer: { x: 0, y: 0, width: 60, height: 40 }
    },
    {
      name: 'an oversized source drawer',
      cabinet: { width_units: 60, height_units: 40 },
      drawer: { x: 0, y: 0, width: 100, height: 60 }
    }
  ])('fails without hanging for $name', async ({ cabinet, drawer }) => {
    const a = drawerFixture({
      id: 'a',
      label: 'A',
      display_number: 1,
      ...drawer
    });
    const layout: LayoutResponse = {
      ...LAYOUT,
      cabinet: { ...CABINET, ...cabinet },
      drawers: [a]
    };
    const { container } = await renderCabinet(layout);

    fireEvent.click(screen.getByRole('button', { name: 'Drawer A' }));
    fireEvent.click(screen.getByLabelText('Duplicate selection'));

    expect(screen.getByText(DUPLICATE_MESSAGE)).toBeVisible();
    expect(entityRects(container)).toHaveLength(1);
  });
});
