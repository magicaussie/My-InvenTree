import { describe, expect, it, vi } from 'vitest';

import {
  normaliseError,
  readEtag,
  StorageLayoutClient
} from '../src/api/client';
import { API_BASE, Endpoints } from '../src/api/endpoints';
import { type LayoutDocument, StorageLayoutApiError } from '../src/api/types';

describe('API endpoints', () => {
  it('mounts under the documented plugin base with trailing slashes', () => {
    expect(API_BASE).toBe('/plugin/storage-layout/api/v1/');
    expect(Endpoints.cabinets()).toBe(
      '/plugin/storage-layout/api/v1/cabinets/'
    );
    expect(Endpoints.cabinetLayout('abc')).toBe(
      '/plugin/storage-layout/api/v1/cabinets/abc/layout/'
    );
    expect(Endpoints.cabinetValidateLayout('abc')).toBe(
      '/plugin/storage-layout/api/v1/cabinets/abc/validate-layout/'
    );
    expect(Endpoints.drawerLayout('d1')).toBe(
      '/plugin/storage-layout/api/v1/drawers/d1/layout/'
    );
    expect(Endpoints.translate()).toBe(
      '/plugin/storage-layout/api/v1/translate/'
    );
    expect(Endpoints.controllerObserve('c1')).toBe(
      '/plugin/storage-layout/api/v1/controllers/c1/observe/'
    );
  });

  it('reads an ETag header case-insensitively', () => {
    expect(readEtag({ headers: { etag: '"3"' } } as never)).toBe('"3"');
    expect(readEtag({ headers: { ETag: '"4"' } } as never)).toBe('"4"');
    expect(readEtag({ headers: {} } as never)).toBeNull();
  });

  it('normalises errors into a typed StorageLayoutApiError', () => {
    const error = normaliseError({
      response: {
        status: 412,
        data: { code: 'stale', message: 'Revision mismatch' }
      }
    });
    expect(error).toBeInstanceOf(StorageLayoutApiError);
    expect(error.isStale).toBe(true);
    expect(error.code).toBe('stale');

    const network = normaliseError({ message: 'boom' });
    expect(network.status).toBe(0);
  });
});

function fakeApi() {
  return {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn()
  };
}

describe('StorageLayoutClient compare-and-swap', () => {
  it('creates a cabinet with an atomically created root location name', async () => {
    const api = fakeApi();
    api.post.mockResolvedValue({ data: { id: 'cabinet' } });
    const client = new StorageLayoutClient(api as never);
    await client.createCabinet({
      name: 'Workbench',
      slug: 'workbench',
      root_location_name: 'Workbench',
      width_units: 600,
      height_units: 800
    });
    expect(api.post).toHaveBeenCalledWith(
      '/plugin/storage-layout/api/v1/cabinets/',
      expect.objectContaining({ root_location_name: 'Workbench' }),
      { headers: {} }
    );
  });

  it('rejects cabinet creation without exactly one location source', async () => {
    const client = new StorageLayoutClient(fakeApi() as never);
    await expect(
      client.createCabinet({
        name: 'x',
        slug: 'x',
        width_units: 1,
        height_units: 1
      })
    ).rejects.toThrow('Provide exactly one');
  });
  it('sends If-Match on layout save and returns the new ETag', async () => {
    const api = fakeApi();
    api.put.mockResolvedValue({
      data: {
        cabinet: { revision: 8 },
        drawers: [],
        bins: [],
        total_pixels: 0,
        active_mapping: null,
        validation: { errors: [], warnings: [] }
      },
      headers: { etag: '"8"' }
    });

    const client = new StorageLayoutClient(api as never);
    const document: LayoutDocument = {
      schema_version: 1,
      cabinet: { width_units: 100, height_units: 100 },
      drawers: [],
      bins: [],
      archive_ids: []
    };

    const result = await client.saveLayout('abc', document, '"7"');

    expect(api.put).toHaveBeenCalledTimes(1);
    const [url, body, config] = api.put.mock.calls[0];
    expect(url).toBe('/plugin/storage-layout/api/v1/cabinets/abc/layout/');
    expect(body).not.toBe(document);
    expect(body.drawers).toEqual([]);
    expect(body.bins).toEqual([]);
    expect(config.headers['If-Match']).toBe('"7"');
    expect(result.etag).toBe('"8"');
  });

  it('requests transactional location creation only for new unbound rows', async () => {
    const api = fakeApi();
    api.put.mockResolvedValue({
      data: { cabinet: {}, drawers: [], bins: [] },
      headers: {}
    });
    const client = new StorageLayoutClient(api as never);
    await client.saveLayout(
      'abc',
      {
        schema_version: 1,
        cabinet: {},
        drawers: [
          {
            id: null,
            is_new: true,
            label: 'D1',
            display_number: 1,
            location: null,
            x: 0,
            y: 0,
            width: 10,
            height: 10,
            interior_width: 10,
            interior_height: 10,
            archived: false,
            allocation: null
          },
          {
            id: 'existing',
            label: 'Existing',
            display_number: 2,
            location: null,
            x: 0,
            y: 0,
            width: 10,
            height: 10,
            interior_width: 10,
            interior_height: 10,
            archived: false,
            allocation: null
          }
        ],
        bins: [
          {
            id: null,
            is_new: true,
            drawer: 'd1',
            label: 'Bin',
            location: null,
            x: 0,
            y: 0,
            width: 5,
            height: 5,
            archived: false
          },
          {
            id: null,
            is_new: true,
            drawer: 'd1',
            label: 'Mapped',
            location: 42,
            x: 0,
            y: 0,
            width: 5,
            height: 5,
            archived: false
          }
        ],
        archive_ids: []
      },
      null
    );
    const body = api.put.mock.calls[0][1];
    expect(body.drawers[0]).toMatchObject({
      location: null,
      auto_create_location: true
    });
    expect(body.drawers[1]).not.toHaveProperty('auto_create_location');
    expect(body.bins[0]).toMatchObject({
      location: null,
      auto_create_location: true
    });
    expect(body.bins[1]).not.toHaveProperty('auto_create_location');
  });

  it('throws a typed error when the save is stale', async () => {
    const api = fakeApi();
    api.put.mockRejectedValue({
      response: { status: 412, data: { code: 'stale' } }
    });
    const client = new StorageLayoutClient(api as never);
    await expect(
      client.saveLayout(
        'abc',
        {
          schema_version: 1,
          cabinet: {},
          drawers: [],
          bins: [],
          archive_ids: []
        },
        '"1"'
      )
    ).rejects.toMatchObject({ status: 412 });
  });

  it('generates an idempotency key for locate sessions', async () => {
    const api = fakeApi();
    api.post.mockResolvedValue({
      data: { id: 'sess', state: 'queued', expires_at: 'now' }
    });
    const client = new StorageLayoutClient(api as never);
    await client.createLocateSession({
      cabinet: 'abc',
      target: { kind: 'drawer', id: 'd1' },
      mode: 'simulate',
      idempotency_key: '',
      approve_live: false
    });
    const [, body] = api.post.mock.calls[0];
    expect(typeof body.idempotency_key).toBe('string');
    expect(body.idempotency_key.length).toBeGreaterThan(0);
  });
});
