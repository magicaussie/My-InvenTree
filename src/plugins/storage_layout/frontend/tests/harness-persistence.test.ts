import { beforeEach, expect, test } from 'vitest';
import { createMockApi, type MockApi } from '../harness/mockApi';
import type { DrawerLayoutDocument, LayoutDocument } from '../src/api/types';

type DrawerResponse = DrawerLayoutDocument & {
  cabinet: { revision: number };
};

const base = '/plugin/storage-layout/api/v1';
// The harness exposes an axios-compatible surface with deliberately opaque args.
function client<T = DrawerResponse>(api: MockApi) {
  return api.instance as unknown as Record<
    string,
    (
      ...args: unknown[]
    ) => Promise<{ data: T; headers: Record<string, string> }>
  >;
}
const match = (revision: number) => ({
  headers: { 'If-Match': `"${revision}"` }
});

beforeEach(() => sessionStorage.clear());

test('drawer properties and independent bins survive reload and a second edit', async () => {
  let api = client(createMockApi());
  const first = await api.get(`${base}/drawers/drawer-1/layout/`);
  const other = await api.get(`${base}/drawers/drawer-2/layout/`);
  const second = await api.put(
    `${base}/drawers/drawer-2/layout/`,
    {
      drawer: {
        ...other.data.drawer,
        label: 'Second',
        display_number: 8,
        interior_width: 240,
        interior_height: 320
      },
      bins: [
        {
          id: 'second-bin',
          label: 'Second bin',
          x: 0,
          y: 0,
          width: 20,
          height: 20
        }
      ]
    },
    match(3)
  );
  expect(second.headers.etag).toBe('"4"');
  expect(second.data.drawer).toMatchObject({
    label: 'Second',
    display_number: 8,
    interior_width: 240,
    interior_height: 320
  });
  expect(second.data.bins[0].drawer).toBe('drawer-2');
  expect((await api.get(`${base}/drawers/drawer-1/layout/`)).data.bins).toEqual(
    first.data.bins
  );

  api = client(createMockApi());
  const reopened = await api.get(`${base}/drawers/drawer-2/layout/`);
  expect(reopened).toEqual(second);
  const edited = await api.put(
    `${base}/drawers/drawer-2/layout/`,
    {
      drawer: { ...reopened.data.drawer, label: 'Edited again' },
      bins: [{ ...reopened.data.bins[0], label: 'Edited bin', width: 30 }]
    },
    match(4)
  );
  expect(edited.headers.etag).toBe('"5"');
  api = client(createMockApi());
  expect((await api.get(`${base}/drawers/drawer-2/layout/`)).data).toEqual(
    edited.data
  );
  expect((await api.get(`${base}/drawers/drawer-1/layout/`)).data.bins).toEqual(
    first.data.bins
  );
});

test('missing and stale revisions reject writes without changing persisted state', async () => {
  const api = client(createMockApi());
  const url = `${base}/drawers/drawer-1/layout/`;
  const original = await api.get(url);
  await api.put(url, original.data, match(3));
  const saved = await api.get(url);
  for (const [config, status] of [
    [undefined, 428],
    [match(3), 412]
  ] as const) {
    await expect(
      api.put(url, { drawer: { label: 'Rejected' }, bins: [] }, config)
    ).rejects.toMatchObject({ response: { status } });
    expect(await client(createMockApi()).get(url)).toEqual(saved);
  }
  expect(original.data.cabinet.revision).toBe(3);
  expect(saved.data.cabinet.revision).toBe(4);
});

test('cabinet dimensions survive save, reload and a second edit', async () => {
  let api = client<LayoutDocument>(createMockApi());
  const url = `${base}/cabinets/${createMockApi().state.cabinet.id}/layout/`;
  const original = await api.get(url);
  const saved = await api.put(
    url,
    {
      ...original.data,
      cabinet: { ...original.data.cabinet, width_units: 640, height_units: 840 }
    },
    match(3)
  );
  expect(saved.data.cabinet).toMatchObject({
    width_units: 640,
    height_units: 840
  });
  expect(saved.headers.etag).toBe('"4"');
  api = client<LayoutDocument>(createMockApi());
  const reopened = await api.get(url);
  expect(reopened).toEqual(saved);
  const edited = await api.put(
    url,
    {
      ...reopened.data,
      cabinet: { ...reopened.data.cabinet, width_units: 720, height_units: 960 }
    },
    match(4)
  );
  expect(edited.data.cabinet).toMatchObject({
    width_units: 720,
    height_units: 960
  });
  expect(edited.headers.etag).toBe('"5"');
  expect(await client<LayoutDocument>(createMockApi()).get(url)).toEqual(
    edited
  );
});

test('fixture seeds are separate and clearing the browser session starts clean', async () => {
  const api = client(createMockApi());
  const url = `${base}/drawers/drawer-1/layout/`;
  await api.put(url, { drawer: { label: 'Saved' }, bins: [] }, match(3));
  expect(createMockApi({ large: true }).state.drawers[0].label).toBe('D1');
  expect(createMockApi().state.drawers[0].label).toBe('Saved');
  sessionStorage.clear();
  expect(createMockApi().state.drawers[0].label).toBe('A1');
  expect(createMockApi().state.revision).toBe(3);
});

test('background metadata and aggregate revision survive reload together', async () => {
  type BackgroundResponse = { metadata: { x: number; opacity: number } };
  const api = client<BackgroundResponse>(createMockApi());
  const url = `${base}/drawers/drawer-2/background/`;
  await api.patch(
    url,
    { x: 12, y: 8, width: 100, height: 80, opacity: 0.7 },
    match(3)
  );
  const reloaded = client<BackgroundResponse>(createMockApi());
  expect(await reloaded.get(url)).toMatchObject({
    data: { metadata: { x: 12, opacity: 0.7 } },
    headers: { etag: '"4"' }
  });
  expect(
    (await reloaded.get(`${base}/drawers/drawer-1/background/`)).data.metadata.x
  ).toBe(0);
});
