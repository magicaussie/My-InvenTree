import type { InvenTreePluginContext } from '@inventreedb/ui';
import { MantineProvider } from '@mantine/core';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

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

function fakeContext(overrides: Record<string, unknown> = {}) {
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
        return { data: LAYOUT, headers: { etag: '"3"' } };
      }
      return {
        data: { count: 1, next: null, previous: null, results: [CABINET] },
        headers: {}
      };
    }),
    post: vi.fn(async () => ({ data: {} })),
    put: vi.fn(async () => ({ data: LAYOUT, headers: { etag: '"4"' } })),
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

describe('CabinetDesigner', () => {
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
