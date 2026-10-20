/**
 * Socket-free fixture API for the browser integration harness.
 *
 * Provides an axios-like `get/post/put/patch` surface backed entirely by
 * in-memory state. It performs **no** network I/O: every request is resolved
 * against the fixture, so the harness never contacts the Django backend, a
 * controller or any other socket.
 *
 * The responses mirror the real serializer/service shapes closely enough to
 * exercise the production frontend paths, including compare-and-swap
 * (`If-Match` -> 412), the flat validation-issue payloads and the locate-session
 * status document.
 */

export interface MockCall {
  method: string;
  url: string;
  body?: unknown;
  headers?: Record<string, string>;
}

interface FixtureDrawer {
  id: string;
  label: string;
  display_number: number;
  location: number | null;
  x: number;
  y: number;
  width: number;
  height: number;
  interior_width: number;
  interior_height: number;
  archived: boolean;
  allocation: {
    id: string;
    logical_start: number;
    logical_end: number;
    pixel_count: number;
  } | null;
}

interface FixtureBin {
  id: string;
  drawer: string;
  label: string;
  location: number | null;
  x: number;
  y: number;
  width: number;
  height: number;
  archived: boolean;
}

export interface MockState {
  revision: number;
  structure: {
    schema_version: 1;
    units: 'mm';
    view: 'front';
    envelope: { width: number; height: number; depth: number };
    features: { id: string; type: string; x: number; y: number; width: number; height: number }[];
  };
  cabinet: {
    id: string;
    name: string;
    slug: string;
    location: number;
    width_units: number;
    height_units: number;
    active_mapping: string | null;
    mapping_hash: string;
    total_pixels: number;
  };
  drawers: FixtureDrawer[];
  bins: FixtureBin[];
  controllers: Record<string, unknown>[];
  sessions: Record<string, Record<string, unknown>>;
  jobs: Record<string, Record<string, unknown>>;
  profiles: Record<string, unknown>[];
  nextSaveStatus: number | null;
}

interface MockConfig {
  headers?: Record<string, string>;
}

interface MockResponse {
  data: unknown;
  status: number;
  headers: Record<string, string>;
}

export interface MockApi {
  instance: Record<string, (...args: never[]) => Promise<MockResponse>>;
  calls: MockCall[];
  state: MockState;
  setNextSaveStatus: (status: number | null) => void;
}

export interface MockOptions {
  /** Seed a large fixture (500 drawers, 2,000 bins) for performance tests. */
  large?: boolean;
}

/** Drawers in the large performance fixture. */
export const LARGE_DRAWER_COUNT = 500;

/** Bins in the large performance fixture (all inside drawer-1). */
export const LARGE_BIN_COUNT = 2000;

class HttpError extends Error {
  response: { status: number; data: unknown };
  constructor(status: number, data: unknown) {
    super(`HTTP ${status}`);
    this.response = { status, data };
  }
}

const BASE = '/plugin/storage-layout/api/v1';

function initialState(): MockState {
  return {
    revision: 3,
    structure: {
      schema_version: 1,
      units: 'mm',
      view: 'front',
      envelope: { width: 300, height: 400, depth: 200 },
      features: []
    },
    cabinet: {
      id: 'cab-1',
      name: 'Cabinet A',
      slug: 'cabinet-a',
      location: 40,
      width_units: 600,
      height_units: 800,
      active_mapping: 'map-1',
      mapping_hash: 'abc123def456',
      total_pixels: 50
    },
    drawers: [
      {
        id: 'drawer-1',
        label: 'A1',
        display_number: 1,
        location: 41,
        x: 10,
        y: 10,
        width: 200,
        height: 100,
        interior_width: 180,
        interior_height: 300,
        archived: false,
        allocation: {
          id: 'alloc-1',
          logical_start: 1,
          logical_end: 50,
          pixel_count: 50
        }
      },
      {
        id: 'drawer-2',
        label: 'A2',
        display_number: 2,
        location: 42,
        x: 10,
        y: 150,
        width: 200,
        height: 100,
        interior_width: 180,
        interior_height: 300,
        archived: false,
        allocation: null
      }
    ],
    bins: [
      {
        id: 'bin-1',
        drawer: 'drawer-1',
        label: 'A1-01',
        location: 43,
        x: 0,
        y: 0,
        width: 40,
        height: 40,
        archived: false
      }
    ],
    controllers: [
      {
        id: 'ctrl-a',
        name: 'Controller A',
        origin: 'http://10.0.0.5',
        expected_mac: null,
        firmware_adapter: 'wled-v16.0.1-1d',
        enabled: false,
        status: 'unknown',
        commissioning_policy: {},
        outputs: [
          {
            id: 'out-1',
            bus_index: 0,
            wled_start: 0,
            pixel_count: 50,
            pins: [16],
            led_type: 'WS2812B',
            colour_order: 'GRB',
            bus_reverse: false,
            skip: 0,
            auto_white_mode: 0,
            max_current_ma: null,
            strings: [
              {
                id: 'str-1',
                label: 'S1',
                output_offset: 0,
                pixel_count: 50,
                notes: '',
                archived: false
              }
            ]
          }
        ]
      }
    ],
    sessions: {},
    jobs: {},
    profiles: [
      {
        id: 'profile-1',
        cabinet: 'cab-1',
        name: 'Locate green',
        purpose: 'locate',
        rgb: [0, 255, 0],
        white: 0,
        brightness: 64,
        duration_seconds: 120
      }
    ],
    nextSaveStatus: null
  };
}

function etagHeaders(revision: number): Record<string, string> {
  return { etag: `"${revision}"` };
}

function layoutDocument(state: MockState) {
  return {
    schema_version: 1,
    cabinet: {
      id: state.cabinet.id,
      name: state.cabinet.name,
      slug: state.cabinet.slug,
      revision: state.revision,
      width_units: state.cabinet.width_units,
      height_units: state.cabinet.height_units,
      archived: false,
      location: state.cabinet.location,
      active_mapping: state.cabinet.active_mapping,
      mapping_hash: state.cabinet.mapping_hash,
      total_pixels: state.cabinet.total_pixels,
      numbering_base: 1
    },
    drawers: state.drawers.map((drawer) => ({ ...drawer })),
    bins: state.bins.map((bin) => ({ ...bin })),
    archive_ids: [],
    diagnostics: {
      valid: true,
      errors: [],
      warnings: [],
      unused_ranges: [[51, state.cabinet.total_pixels]],
      total_pixels: state.cabinet.total_pixels,
      mapping_hash: state.cabinet.mapping_hash,
      numbering_base: 1
    }
  };
}

function electricalDocument(state: MockState) {
  return {
    schema_version: 1,
    cabinet: { id: state.cabinet.id, revision: state.revision },
    controllers: state.controllers,
    archive_ids: []
  };
}

function translateRun(state: MockState, start: number, end: number) {
  const controller = state.controllers[0] as {
    id: string;
    outputs: { id: string; strings: { id: string }[] }[];
  };
  const output = controller.outputs[0];
  return [
    {
      logical_start: start,
      logical_end: end,
      controller: controller.id,
      output: output.id,
      string: output.strings[0].id,
      wled_start: Math.max(0, start - 1),
      wled_stop: end,
      direction: 1
    }
  ];
}

function sessionStatus(state: MockState, sessionId: string) {
  const session = state.sessions[sessionId];
  return {
    id: sessionId,
    cabinet: state.cabinet.id,
    state: (session?.state as string) ?? 'active',
    mode: (session?.mode as string) ?? 'simulate',
    target: session?.target ?? { kind: 'drawer', label: 'A1', pk: 'drawer-1' },
    mapping_hash: state.cabinet.mapping_hash,
    layout_revision: state.revision,
    profile: {
      name: 'default',
      purpose: 'locate',
      rgb: [0, 255, 0],
      white: 0,
      brightness: 64,
      duration_seconds: 120
    },
    plan: {
      mode: (session?.mode as string) ?? 'simulate',
      drawer: 'drawer-1',
      drawer_label: 'A1',
      logical_start: 1,
      logical_end: 50,
      runs: translateRun(state, 1, 50),
      controllers: ['ctrl-a']
    },
    failure: null,
    executions: [
      {
        controller: 'ctrl-a',
        state: (session?.state as string) ?? 'active',
        last_step: 'apply',
        clear_status: 'not_required',
        acknowledged_at: null,
        error: null
      }
    ],
    expires_at: '2030-01-01T00:00:00Z',
    created_at: '2030-01-01T00:00:00Z',
    status_url: `${BASE}/locate-sessions/${sessionId}/`
  };
}

function drawerLayoutDocument(state: MockState) {
  return {
    schema_version: 1,
    cabinet: {
      id: state.cabinet.id,
      revision: state.revision,
      active_mapping: state.cabinet.active_mapping,
      total_pixels: state.cabinet.total_pixels
    },
    drawer: { ...state.drawers[0] },
    bins: state.bins.map((bin) => ({ ...bin })),
    archive_ids: []
  };
}

function mapBins(entries: Record<string, unknown>[]): FixtureBin[] {
  return entries.map((entry, index) => ({
    id: (entry.id as string) ?? `new-bin-${index}`,
    drawer: String(entry.drawer ?? ''),
    label: String(entry.label ?? ''),
    location: (entry.location as number | null) ?? null,
    x: Number(entry.x ?? 0),
    y: Number(entry.y ?? 0),
    width: Number(entry.width ?? 1),
    height: Number(entry.height ?? 1),
    archived: Boolean(entry.archived)
  }));
}

function applyLayoutBody(state: MockState, body: Record<string, unknown>) {
  const cabinet = (body.cabinet ?? {}) as Record<string, unknown>;
  if (typeof cabinet.width_units === 'number') {
    state.cabinet.width_units = cabinet.width_units;
  }
  if (typeof cabinet.height_units === 'number') {
    state.cabinet.height_units = cabinet.height_units;
  }

  const previous = new Map(state.drawers.map((drawer) => [drawer.id, drawer]));
  const drawers = (body.drawers ?? []) as Record<string, unknown>[];

  state.drawers = drawers.map((entry, index) => {
    const id = (entry.id as string) ?? `new-drawer-${index}`;
    const allocation = entry.allocation as Record<string, number> | null;
    return {
      id,
      label: String(entry.label ?? ''),
      display_number: Number(entry.display_number ?? 1),
      location: (entry.location as number | null) ?? null,
      x: Number(entry.x ?? 0),
      y: Number(entry.y ?? 0),
      width: Number(entry.width ?? 1),
      height: Number(entry.height ?? 1),
      interior_width: Number(entry.interior_width ?? 1),
      interior_height: Number(entry.interior_height ?? 1),
      archived: Boolean(entry.archived),
      allocation: allocation
        ? {
            id: `alloc-${id}`,
            logical_start: Number(allocation.logical_start),
            logical_end: Number(allocation.logical_end),
            pixel_count:
              Number(allocation.logical_end) -
              Number(allocation.logical_start) +
              1
          }
        : (previous.get(id)?.allocation ?? null)
    };
  });

  state.bins = mapBins((body.bins ?? []) as Record<string, unknown>[]);
}

function locationBinding(state: MockState, pk: number) {
  const cabinet = state.cabinet;
  const drawer = state.drawers.find((entry) => entry.location === pk) ?? null;
  const bin = state.bins.find((entry) => entry.location === pk) ?? null;

  let role: 'cabinet' | 'drawer' | 'bin' | null = null;
  let boundDrawer = drawer;

  if (cabinet.location === pk) {
    role = 'cabinet';
    boundDrawer = null;
  } else if (bin) {
    role = 'bin';
    boundDrawer = state.drawers.find((entry) => entry.id === bin.drawer) ?? null;
  } else if (drawer) {
    role = 'drawer';
  }

  const allocation = boundDrawer?.allocation ?? null;
  const locatable = Boolean(boundDrawer && allocation);

  let reason = '';
  if (!role) reason = 'unbound';
  else if (role === 'cabinet') reason = 'cabinet_root';
  else if (!locatable) reason = 'no_allocation';

  return {
    location: pk,
    bound: Boolean(role),
    role,
    cabinet: role
      ? {
          id: cabinet.id,
          name: cabinet.name,
          slug: cabinet.slug,
          revision: state.revision,
          active_mapping: cabinet.active_mapping,
          mapping_hash: cabinet.mapping_hash,
          total_pixels: cabinet.total_pixels
        }
      : null,
    drawer: boundDrawer
      ? {
          id: boundDrawer.id,
          label: boundDrawer.label,
          display_number: boundDrawer.display_number,
          allocation
        }
      : null,
    bin: bin ? { id: bin.id, label: bin.label } : null,
    locatable,
    reason
  };
}

function largeState(): MockState {
  const base = initialState();
  const columns = 25;
  const totalPixels = LARGE_DRAWER_COUNT * 50;

  base.cabinet.width_units = columns * 120;
  base.cabinet.height_units = Math.ceil(LARGE_DRAWER_COUNT / columns) * 70;
  base.cabinet.total_pixels = totalPixels;
  base.cabinet.mapping_hash = 'large-fixture-hash';

  base.drawers = Array.from({ length: LARGE_DRAWER_COUNT }, (_, index) => ({
    id: `drawer-${index + 1}`,
    label: `D${index + 1}`,
    display_number: index + 1,
    location: 1000 + index,
    x: (index % columns) * 120,
    y: Math.floor(index / columns) * 70,
    width: 110,
    height: 60,
    interior_width: index === 0 ? 500 : 100,
    interior_height: index === 0 ? 400 : 50,
    archived: false,
    allocation: {
      id: `alloc-${index + 1}`,
      logical_start: index * 50 + 1,
      logical_end: index * 50 + 50,
      pixel_count: 50
    }
  }));

  // All 2,000 bins live in drawer-1 so the drawer designer is stressed too.
  base.bins = Array.from({ length: LARGE_BIN_COUNT }, (_, index) => ({
    id: `bin-${index + 1}`,
    drawer: 'drawer-1',
    label: `B${index + 1}`,
    location: 10000 + index,
    x: (index % 50) * 10,
    y: Math.floor(index / 50) * 10,
    width: 9,
    height: 9,
    archived: false
  }));

  return base;
}

export function createMockApi(options: MockOptions = {}): MockApi {
  const state = options.large ? largeState() : initialState();
  const calls: MockCall[] = [];

  function requireMatch(config?: MockConfig) {
    if (state.nextSaveStatus) {
      const status = state.nextSaveStatus;
      state.nextSaveStatus = null;
      throw new HttpError(status, {
        code: status === 412 ? 'stale' : 'error',
        message:
          status === 412
            ? 'The cabinet revision has changed'
            : 'Injected failure'
      });
    }
    const ifMatch = config?.headers?.['If-Match'];
    if (!ifMatch) {
      throw new HttpError(428, {
        code: 'precondition_required',
        message: 'An If-Match header is required'
      });
    }
    if (ifMatch !== `"${state.revision}"` && ifMatch !== String(state.revision)) {
      throw new HttpError(412, {
        code: 'stale',
        message: 'The cabinet revision has changed'
      });
    }
  }

  function handle(
    method: string,
    rawUrl: string,
    body: unknown,
    config?: MockConfig
  ): MockResponse {
    const path = rawUrl.split('?')[0].replace(BASE, '');
    const ok = (data: unknown, status = 200): MockResponse => ({
      data,
      status,
      headers: {}
    });
    const doc = (body ?? {}) as Record<string, unknown>;

    if (method === 'GET' && path === '/cabinets/') {
      return ok({
        count: 1,
        next: null,
        previous: null,
        results: [
          {
            id: state.cabinet.id,
            name: state.cabinet.name,
            slug: state.cabinet.slug,
            location: state.cabinet.location,
            width_units: state.cabinet.width_units,
            height_units: state.cabinet.height_units,
            revision: state.revision,
            archived: false,
            active_mapping: state.cabinet.active_mapping,
            default_profile: null
          }
        ]
      });
    }

    if (method === 'GET' && /^\/cabinets\/[^/]+\/$/.test(path)) {
      return ok({
        id: state.cabinet.id,
        name: state.cabinet.name,
        slug: state.cabinet.slug,
        location: state.cabinet.location,
        width_units: state.cabinet.width_units,
        height_units: state.cabinet.height_units,
        revision: state.revision,
        structure: state.structure,
        archived: false,
        active_mapping: state.cabinet.active_mapping,
        default_profile: null
      });
    }

    if (method === 'PATCH' && /^\/cabinets\/[^/]+\/$/.test(path)) {
      requireMatch(config);
      if ('structure' in doc) state.structure = doc.structure as MockState['structure'];
      state.revision += 1;
      const response = ok({ ...state.cabinet, revision: state.revision, structure: state.structure });
      response.headers = etagHeaders(state.revision);
      return response;
    }

    if (method === 'GET' && path === `/cabinets/${state.cabinet.id}/layout/`) {
      const response = ok(layoutDocument(state));
      response.headers = etagHeaders(state.revision);
      return response;
    }

    if (method === 'PUT' && path === `/cabinets/${state.cabinet.id}/layout/`) {
      requireMatch(config);
      applyLayoutBody(state, doc);
      state.revision += 1;
      const response = ok(layoutDocument(state));
      response.headers = etagHeaders(state.revision);
      return response;
    }

    if (
      method === 'POST' &&
      path === `/cabinets/${state.cabinet.id}/validate-layout/`
    ) {
      const drawers = (doc.drawers ?? []) as Record<string, unknown>[];
      const errors: Record<string, unknown>[] = [];
      for (let i = 0; i < drawers.length; i += 1) {
        for (let j = i + 1; j < drawers.length; j += 1) {
          const a = drawers[i];
          const b = drawers[j];
          const overlap =
            Number(a.x) < Number(b.x) + Number(b.width) &&
            Number(b.x) < Number(a.x) + Number(a.width) &&
            Number(a.y) < Number(b.y) + Number(b.height) &&
            Number(b.y) < Number(a.y) + Number(a.height);
          if (overlap) {
            errors.push({
              path: '',
              code: 'geometry_overlap',
              message: 'Drawer rectangles must not overlap',
              related_ids: [String(a.id), String(b.id)]
            });
          }
        }
      }
      return ok({
        valid: errors.length === 0,
        errors,
        warnings: [],
        unused_ranges: []
      });
    }

    if (method === 'GET' && path === `/cabinets/${state.cabinet.id}/electrical/`) {
      const response = ok(electricalDocument(state));
      response.headers = etagHeaders(state.revision);
      return response;
    }

    if (method === 'PUT' && path === `/cabinets/${state.cabinet.id}/electrical/`) {
      requireMatch(config);
      if (Array.isArray(doc.controllers)) {
        state.controllers = doc.controllers as Record<string, unknown>[];
      }
      state.revision += 1;
      const response = ok(electricalDocument(state));
      response.headers = etagHeaders(state.revision);
      return response;
    }

    if (
      method === 'POST' &&
      path === `/cabinets/${state.cabinet.id}/mapping-preview/`
    ) {
      const total = Number(doc.total_pixels ?? 0);
      const spans = (doc.spans ?? []) as unknown[];
      return ok({
        valid: true,
        errors: [],
        warnings: [],
        unused_ranges: [],
        total_pixels: total,
        mapping_hash: `hash-${total}-${spans.length}`,
        samples: [{ logical: 1, runs: translateRun(state, 1, 1) }],
        drawer_impacts: []
      });
    }

    if (
      method === 'POST' &&
      path === `/cabinets/${state.cabinet.id}/mapping-publish/`
    ) {
      requireMatch(config);
      state.revision += 1;
      state.cabinet.active_mapping = 'map-2';
      state.cabinet.total_pixels = Number(doc.total_pixels ?? 0);
      state.cabinet.mapping_hash = `hash-${doc.total_pixels}-publish`;
      const response = ok(
        {
          id: 'map-2',
          number: 2,
          state: 'published',
          total_pixels: state.cabinet.total_pixels,
          mapping_hash: state.cabinet.mapping_hash,
          revision: state.revision,
          changed_pixels: [
            { logical: 1, before: ['ctrl-a', 0], after: ['ctrl-a', 5] }
          ],
          changed_count: 1,
          changed_truncated: false
        },
        201
      );
      response.headers = etagHeaders(state.revision);
      return response;
    }

    if (/\/cabinets\/[^/]+\/(arm|disarm|stop)\/$/.test(path)) {
      if (path.endsWith('/arm/')) {
        return ok(
          {
            cabinet: state.cabinet.id,
            armed_until: '2030-01-01T00:15:00Z',
            controllers: ['ctrl-a']
          },
          202
        );
      }
      if (path.endsWith('/disarm/')) {
        return ok({ cabinet: state.cabinet.id, armed_until: null });
      }
      return ok({ cabinet: state.cabinet.id, stopped_session: null }, 202);
    }

    if (method === 'POST' && path === `/cabinets/${state.cabinet.id}/pixel-tests/`) {
      const id = 'session-pixel';
      state.sessions[id] = { state: 'queued', polls: 0, mode: 'simulate' };
      return ok(sessionStatus(state, id), 202);
    }

    if (method === 'GET' && /^\/locations\/\d+\/binding\/$/.test(path)) {
      const pk = Number(path.split('/')[2]);
      return ok(locationBinding(state, pk));
    }

    if (method === 'GET' && /^\/drawers\/[^/]+\/layout\/$/.test(path)) {
      const response = ok(drawerLayoutDocument(state));
      response.headers = etagHeaders(state.revision);
      return response;
    }

    if (method === 'PUT' && /^\/drawers\/[^/]+\/layout\/$/.test(path)) {
      requireMatch(config);
      state.bins = mapBins((doc.bins ?? []) as Record<string, unknown>[]);
      state.revision += 1;
      const response = ok(drawerLayoutDocument(state));
      response.headers = etagHeaders(state.revision);
      return response;
    }

    if (method === 'POST' && path === '/translate/') {
      const payload = doc as unknown as Record<string, number>;
      return ok({
        mapping_hash: state.cabinet.mapping_hash,
        total_pixels: state.cabinet.total_pixels,
        logical_start: payload.logical_start,
        logical_end: payload.logical_end,
        pixel_count: payload.logical_end - payload.logical_start + 1,
        runs: translateRun(state, payload.logical_start, payload.logical_end)
      });
    }

    if (method === 'POST' && path === '/locate-sessions/') {
      const id = `session-${Object.keys(state.sessions).length + 1}`;
      const target = (doc.target ?? {}) as Record<string, unknown>;
      state.sessions[id] = {
        state: 'queued',
        polls: 0,
        mode: doc.mode ?? 'simulate',
        target: { kind: target.kind ?? 'drawer', label: 'A1', pk: String(target.id ?? '') }
      };
      return ok(sessionStatus(state, id), 202);
    }

    if (method === 'GET' && /^\/locate-sessions\/[^/]+\/$/.test(path)) {
      const id = path.split('/')[2];
      const session = state.sessions[id];
      // Simulate the background worker: the first poll moves the session from
      // `queued` to `active`.
      if (session && session.state === 'queued') {
        session.polls = ((session.polls as number) ?? 0) + 1;
        if ((session.polls as number) >= 1) session.state = 'active';
      }
      return ok(sessionStatus(state, id));
    }

    if (method === 'POST' && /^\/locate-sessions\/[^/]+\/stop\/$/.test(path)) {
      const id = path.split('/')[2];
      if (state.sessions[id]) state.sessions[id].state = 'stopped';
      return ok(sessionStatus(state, id), 202);
    }

    if (method === 'GET' && path === '/locate-sessions/') {
      return ok({ count: 0, next: null, previous: null, results: [] });
    }

    if (method === 'POST' && path === '/discovery/') {
      const id = `job-${Object.keys(state.jobs).length + 1}`;
      state.jobs[id] = {
        id,
        kind: 'discovery',
        state: 'pending',
        polls: 0,
        mode: 'simulate',
        result: { candidates: [] }
      };
      return ok(state.jobs[id], 202);
    }

    if (method === 'POST' && /\/controllers\/[^/]+\/observe\/$/.test(path)) {
      const id = 'job-observe';
      state.jobs[id] = {
        id,
        kind: 'observe',
        state: 'pending',
        polls: 0,
        mode: 'simulate',
        result: {
          observation: 'obs-1',
          fingerprint: 'fp-1',
          capability_status: 'supported'
        },
        observation_detail: {
          id: 'obs-1',
          controller: 'ctrl-a',
          fingerprint: 'fp-1',
          capability_status: 'supported',
          observed_at: '2030-01-01T00:00:00Z',
          diff: {}
        }
      };
      return ok(state.jobs[id], 202);
    }

    if (method === 'POST' && /\/controllers\/[^/]+\/import-preview\/$/.test(path)) {
      return ok({
        observation: 'obs-1',
        fingerprint: 'fp-1',
        capability_status: 'supported',
        diff_hash: 'diff-1',
        added: [],
        changed: [],
        removed: []
      });
    }

    if (/\/controllers\/[^/]+\/(import|approve-configuration)\/$/.test(path)) {
      return ok({ observation: 'obs-1', status: 'applied' });
    }

    if (method === 'GET' && /^\/jobs\/[^/]+\/$/.test(path)) {
      const id = path.split('/')[2];
      const job = state.jobs[id];
      // Simulate dispatch: pending -> running -> complete over two polls.
      if (job) {
        job.polls = ((job.polls as number) ?? 0) + 1;
        const polls = job.polls as number;
        if (polls >= 2) job.state = 'complete';
        else job.state = 'running';
        // Return a fresh object, as a real HTTP response would.
        return ok({ ...job });
      }
      return ok({ id, kind: 'discovery', state: 'complete', mode: 'simulate' });
    }

    if (method === 'GET' && path.startsWith('/profiles/')) {
      return ok({
        count: state.profiles.length,
        next: null,
        previous: null,
        results: state.profiles
      });
    }

    if (method === 'POST' && path === '/profiles/') {
      const created = {
        id: `profile-${state.profiles.length + 1}`,
        cabinet: state.cabinet.id,
        name: doc.name ?? 'profile',
        purpose: doc.purpose ?? 'locate',
        rgb: [doc.rgb_r ?? 0, doc.rgb_g ?? 255, doc.rgb_b ?? 0],
        white: doc.white ?? 0,
        brightness: doc.brightness ?? 64,
        duration_seconds: doc.duration_seconds ?? 120
      };
      state.profiles.push(created);
      return ok(created, 201);
    }

    if (method === 'PATCH' && path.startsWith('/profiles/')) {
      const id = path.split('/')[2];
      const existing = state.profiles.find((item) => item.id === id);
      if (existing) {
        if (doc.name !== undefined) existing.name = doc.name;
        if (doc.purpose !== undefined) existing.purpose = doc.purpose;
        if (
          doc.rgb_r !== undefined ||
          doc.rgb_g !== undefined ||
          doc.rgb_b !== undefined
        ) {
          const rgb = (existing.rgb as number[]) ?? [0, 0, 0];
          existing.rgb = [
            doc.rgb_r ?? rgb[0],
            doc.rgb_g ?? rgb[1],
            doc.rgb_b ?? rgb[2]
          ];
        }
        if (doc.white !== undefined) existing.white = doc.white;
        if (doc.brightness !== undefined) existing.brightness = doc.brightness;
        if (doc.duration_seconds !== undefined) {
          existing.duration_seconds = doc.duration_seconds;
        }
        return ok({ ...existing });
      }
      return ok({ id, cabinet: state.cabinet.id, name: 'profile' });
    }

    throw new HttpError(404, {
      code: 'not_found',
      message: `No fixture route for ${method} ${path}`
    });
  }

  function wrap(method: string) {
    return async (
      url: string,
      bodyOrConfig?: unknown,
      maybeConfig?: unknown
    ): Promise<MockResponse> => {
      const isWrite = method !== 'GET';
      const body = isWrite ? bodyOrConfig : undefined;
      const config = (isWrite ? maybeConfig : bodyOrConfig) as
        | MockConfig
        | undefined;
      calls.push({ method, url, body, headers: config?.headers });
      await Promise.resolve();
      return handle(method, url, body, config);
    };
  }

  return {
    instance: {
      get: wrap('GET'),
      post: wrap('POST'),
      put: wrap('PUT'),
      patch: wrap('PATCH')
    },
    calls,
    state,
    setNextSaveStatus: (status: number | null) => {
      state.nextSaveStatus = status;
    }
  };
}
