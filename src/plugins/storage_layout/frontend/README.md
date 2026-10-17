# Storage Layout & WLED — plugin frontend

Graphical **cabinet designer** and **drawer/bin designer** for the Storage
Layout InvenTree plugin, plus the electrical topology editor, mapping
preview/publish tools and simulation/diagnostic controls.

The compiled bundle is written to `../storage_layout/static/` and located by
`InvenTreePlugin.plugin_static_file` via the Vite manifest. The frontend uses
only the **public UI SDK** (`@inventreedb/ui` types and the externalised React /
Mantine / Lingui libraries) and never deep-imports host application internals.

## Layout

```
frontend/
├── package.json          # depends on @inventreedb/ui
├── vite.config.ts        # production build -> ../storage_layout/static
├── vite.dev.config.ts    # HMR dev server on :5174
├── vitest.config.ts      # unit + component tests (jsdom)
└── src/
    ├── storage_layout.tsx        # PUBLIC ENTRY: exports referenced by plugin.py
    ├── api/                      # typed client for /plugin/storage-layout/api/v1/
    ├── state/                    # pure geometry, command history, validation,
    │                             #   grid generator, logical->physical translator
    └── components/               # designers, SVG canvas, inspectors, panels
```

## Commands

```bash
cd src/plugins/storage_layout/frontend
npm install            # install dependencies
npm run typecheck      # tsc --noEmit
npm run lint           # biome check
npm test               # vitest run

npm run extract        # lingui extract (scan src for t/Trans messages)
npm run compile        # lingui compile --typescript (emit catalogs)
npm run translate      # extract + compile

npm run build          # compile catalogs + tsc + vite build -> ../storage_layout/static
npm run dev            # HMR dev server (requires plugin_dev config)

# Browser integration tests (Playwright + Chromium)
npm run e2e:install    # one-time: download the Chromium browser
npm run e2e            # builds the plugin, starts the harness, drives Chromium
```

The build emits hashed entry files (e.g. `storage_layout-<hash>.js`) and a
`.vite/manifest.json` into `../storage_layout/static/`. After building, run
`invoke collectplugins` (or restart/enable the plugin) so the static files are
copied into the served static tree.

## Browser integration tests (socket-free)

The Playwright suite loads the **real built plugin bundle** in Chromium and
drives it against an in-memory fixture API. It is completely self-contained:
it needs no Django backend, and the fixture opens **no sockets** (every request
is resolved against in-page state).

- `harness/` - a tiny Vite app that assigns the host `window` globals
  (`React`, `MantineCore`, ...) and loads the bundle via a native module script,
  then renders the requested entry function with a fake plugin context.
- `harness/mockApi.ts` - the fixture API (all `/plugin/storage-layout/api/v1/`
  endpoints, compare-and-swap, flat validation-issue payloads and the
  locate-session status document).
- `scripts/prepare-harness.mjs` - copies the built bundle + manifest into the
  harness public directory.
- `e2e/designers.spec.ts` - proves: bundle loads/exports; cabinet designer
  loads geometry, allocation bands, coverage ruler and server diagnostics;
  pointer drag + undo/redo; numeric edits + undo; explicit save with `If-Match`
  compare-and-swap; stale-save conflict dialog retaining the draft; server
  validation; drawer bin-grid generation that skips existing bins; simulated
  locate session with the translated plan; mapping preview + publish with
  `If-Match`.

## Public UI declarations (now wired into `plugin.py`)

The declarations below are **already implemented** in
`storage_layout/plugin.py` (`UserInterfaceMixin`, `get_ui_routes`,
`get_ui_panels`). They are reproduced here for reference. Only
`ENABLE_PLUGINS_INTERFACE` (routes/panels) and `ENABLE_PLUGINS_URL` (the REST
API this frontend consumes) need to be enabled.

```python
from plugin.mixins import AppMixin, SettingsMixin, UserInterfaceMixin, ValidationMixin


class StorageLayoutPlugin(
    AppMixin, SettingsMixin, UserInterfaceMixin, ValidationMixin, InvenTreePlugin
):
    ...

    def get_ui_routes(self, request, context, **kwargs):
        """Custom React routes (resolved under /web/plugin/storage-layout/)."""
        return [
            {
                'key': 'storage-layout-cabinets',
                'title': _('Storage Layout'),
                'icon': 'ti:layout-grid:outline',
                'source': self.plugin_static_file(
                    'storage_layout.js:RenderCabinetList'
                ),
                'options': {'path': 'cabinets'},
            },
            {
                'key': 'storage-layout-cabinet-design',
                'title': _('Cabinet Designer'),
                'icon': 'ti:layout-grid:outline',
                'source': self.plugin_static_file(
                    'storage_layout.js:RenderCabinetDesigner'
                ),
                'options': {'path': 'cabinets/:id/design'},
            },
            {
                'key': 'storage-layout-drawer-design',
                'title': _('Drawer Designer'),
                'icon': 'ti:layout-grid:outline',
                'source': self.plugin_static_file(
                    'storage_layout.js:RenderDrawerDesigner'
                ),
                'options': {'path': 'drawers/:id/design'},
            },
        ]

    def get_ui_panels(self, request, context, **kwargs):
        """Additive panel on the native stock location detail page.

        The host passes the page's model and id as `target_model` / `target_id`
        query parameters.
        """
        if context.get('target_model') != 'stocklocation':
            return []
        return [
            {
                'key': 'storage-layout-location-panel',
                'title': _('Storage Layout'),
                'icon': 'ti:layout-grid:outline',
                'source': self.plugin_static_file(
                    'storage_layout.js:RenderStorageLocationPanel'
                ),
            }
        ]
```

### Required feature gates

`ENABLE_PLUGINS_INTERFACE` must be enabled for routes, navigation and panels
to appear. `ENABLE_PLUGINS_URL` is required for the REST API this frontend
consumes.

### Exported entry functions

| Export | Kind | Route / context | Notes |
| ------ | ---- | --------------- | ----- |
| `RenderCabinetList` | route | `cabinets` | Cabinet list and creation. |
| `RenderCabinetDesigner` | route | `cabinets/:id/design` | Reads `:id` from the URL. |
| `RenderDrawerDesigner` | route | `drawers/:id/design` | Reads `:id` from the URL. |
| `RenderStorageLocationPanel` | panel | `stocklocation` detail | Binding (cabinet/drawer/bin) + locate action. |
| `RenderStockItemPanel` | panel | `stockitem` detail | Actor-safe item locate action. |

A top-level **navigation item** (`get_ui_navigation_items`) links to
`plugin/storage-layout/cabinets`.

Every export is capitalised (React Fast Refresh requirement) and accepts a
single `InvenTreePluginContext` argument.

## Async polling contract

The backend dispatches locate/pixel-test sessions and observe/discovery jobs to
the background worker, so a create request returns a **pending** document
(`queued` for sessions, `pending` for jobs). The frontend polls the durable
status endpoint until it settles:

- sessions: `GET locate-sessions/{id}/` until `stopped`/`expired`/`failed`/`unknown`;
- read jobs: `GET jobs/{id}/` until `complete`/`failed`/`expired`.

The state sets and poll cadence live in `src/state/session.ts` and are covered
by unit tests; the browser tests exercise the `queued -> active` and
`pending -> running -> complete` transitions.

## Consumed REST API

The frontend calls the plugin API documented in the design (§5), mounted at
`/plugin/storage-layout/api/v1/`:

`cabinets/`, `cabinets/{id}/layout/`, `cabinets/{id}/validate-layout/`,
`cabinets/{id}/electrical/`, `cabinets/{id}/mapping-preview/`,
`cabinets/{id}/mapping-publish/`, `cabinets/{id}/arm|disarm|stop|pixel-tests/`,
`drawers/{id}/layout/`, `controllers/{id}/observe|import-preview|import|approve-configuration/`,
`translate/`, `discovery/`, `locate-sessions/` (+ `stop/`), `profiles/`,
`jobs/{id}/`.

Layout and electrical writes use compare-and-swap: the client stores the `ETag`
returned by the GET and sends it as `If-Match`; HTTP 412 keeps the local draft
and surfaces a conflict dialog (never an automatic merge).

## Packaging the built assets

The build output (`../storage_layout/static/`) is not a Python package, so it is
declared explicitly in the plugin's `pyproject.toml`:

```toml
[tool.setuptools.package-data]
storage_layout = ["static/*", "static/.vite/*", "static/**/*.js", ...]
```

InvenTree additionally collects the files via `invoke collectplugins` into
`plugins/storage-layout/` for serving. No other backend change is required.

## Reconciled API contract

The types in `src/api/types.ts` were reconciled against the implemented
serializers and services. Notable confirmed behaviours:

- `GET cabinets/{id}/layout/` returns the layout document **plus** a top-level
  `diagnostics` payload (`{valid, errors, warnings, unused_ranges, total_pixels,
  mapping_hash, numbering_base}`); the panel surfaces those counts.
- Validation issues are `{path, code, message, related_ids}` with **no**
  `severity`; the client injects severity from the containing `errors` /
  `warnings` array (`normaliseReport`).
- `GET cabinets/{id}/electrical/` nests `strings` inside each output.
- `POST cabinets/{id}/mapping-preview/` returns flat `errors`/`warnings` plus
  `samples` and `drawer_impacts`; `mapping-publish/` returns
  `{id, number, state, total_pixels, mapping_hash, revision}` and requires
  `If-Match`.
- `POST locate-sessions/` and `GET locate-sessions/{id}/` return the session
  status document (`target`, `plan.runs`, `executions`) and the create response
  is **pending** (`queued`).
- `POST controllers/{id}/observe/` and `POST discovery/` return a **pending**
  hardware read job which must be polled.
- `GET drawers/{id}/layout/` omits the mapping hash, so the drawer designer
  reads it from the cabinet layout document.

## Plugin backend additions made for this frontend

To satisfy the spec's requirement that the location panel resolve **drawers and
bins** (not only cabinet roots), one additive, non-core plugin endpoint was
added:

- `GET /plugin/storage-layout/api/v1/locations/<pk>/binding/`
  (`services.location_binding`) returns the binding role, cabinet summary,
  drawer/allocation and whether the location is locatable. Ownership is
  enforced (a location the user may not access is reported as `404`).

No InvenTree core files are modified.

## Internationalisation (Lingui)

Every user-visible string is wrapped in a Lingui `t` macro, matching the host
i18n contract:

- Catalogs live in `src/locales/<locale>/messages.po` (tracked) and are
  compiled by `npm run compile` into `src/locales/<locale>/messages.ts`
  (generated, gitignored). Locales mirror the host list (`de`, `en`, `es`,
  `fr`, `it`, `ja`, `ru`, `zh_Hans`, `zh_Hant`, `pseudo-LOCALE`).
- `lingui.config.ts` drives extraction; the `@vitejs/plugin-react` `macros`
  Babel plugin (configured in `vite.config.ts`, `vite.dev.config.ts` and
  `vitest.config.ts`) compiles the macros away at build/test time.
- `src/locales.ts` exposes a `loadLocale` loader (typed with the SDK's public
  `LocaleLoader`). `src/i18n.tsx` (`PluginLocale`) loads the requested catalog
  into the **host** i18n instance from `context.i18n` and wraps the tree in
  `I18nProvider`, so `t` (which compiles to the global `@lingui/core` i18n
  singleton - the same object the host passes) resolves against the active
  locale. Locale fallbacks (`xx-YY` -> `xx` -> `en`) are applied, and children
  are still rendered if no catalog loads.

`PluginLocale` re-implements the SDK's `LocalizedComponent` locally: importing
any runtime value from `@inventreedb/ui` would pull the whole host UI library
into the bundle, because that package declares no `sideEffects` field. The SDK
remains a **type-only** dependency (`InvenTreePluginContext`, `LocaleLoader`).

> Translations for languages other than English are currently placeholders
> (the compiled catalogs fall back to the English source strings).

## Performance

The browser suite includes measured budgets from the design (500 drawers per
cabinet, 2,000 bins per drawer):

- `cabinet designer meets the 500 drawer performance budget`
- `drawer designer meets the 2,000 bin performance budget`

Measured on the harness in Chromium (headless):

| Fixture | Rendered | Time to interactive (measured) |
| ------- | -------- | ------------------------------ |
| 500 drawers | 500 SVG entities + 500 list rows | **276-302 ms** |
| 2,000 bins | 2,000 SVG entities | **346-359 ms** |

Budgets in the tests are deliberately generous (10 s / 15 s) so they fail only
on a real regression; the measured values are logged by the tests.

## Notes / limitations

- The location panel now resolves cabinet/drawer/bin bindings via the additive
  binding endpoint above; a `?location=` filter on the list endpoints remains a
  possible alternative future refinement.
- The mapping panel and allocation bands resolve controller/string boundaries
  through `GET cabinets/{id}/electrical/`; no hardware I/O is performed by any
  layout/mapping action.
- Only English source strings are populated; other locales are untranslated
  placeholders.
- The browser suite runs in Chromium only (Firefox/WebKit are not installed).
- Performance is measured in a headless harness with an in-memory fixture, so
  it bounds frontend rendering cost only (no backend/network latency).
