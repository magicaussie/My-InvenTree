# Storage Layout & WLED (InvenTree plugin)

Installable InvenTree plugin implementing the storage-layout domain described in
[`docs/design/001 - Storage Layout & WLED.md`](../../../docs/design/001%20-%20Storage%20Layout%20&%20WLED.md).

The plugin owns the storage/electrical/mapping domain, a graphical cabinet and
drawer/bin designer, and a **simulation-first** safe locating service. Native
InvenTree inventory (locations, stock, movements, tracking) is referenced, never
duplicated.

> **Status:** backend models/validation/mapping/API, the WLED adapter and the
> frontend are implemented and covered by the plugin test suites. Hardware
> operation is **disabled by default**; the plugin is simulation-only until an
> operator enables and commissions it (see *Hardware safety*). No live
> controller access or commissioning has been performed. The design document's
> owner decisions (§16) are adopted as **proposed defaults**, not owner-approved
> values.

## Layout

```
src/plugins/storage_layout/          # distribution root (pyproject.toml)
├── storage_layout/                  # importable Python package (app label `storage_layout`)
│   ├── apps.py                      # Django AppConfig
│   ├── plugin.py                    # InvenTreePlugin definition (entry point target)
│   ├── models.py                    # plugin-owned database models
│   ├── validation.py                # authoritative cross-row validation module
│   ├── mapping.py                   # pure logical→physical translator + manifest hash
│   ├── serializers.py               # DRF wire contracts
│   ├── services.py                  # transactional domain services (CAS, sessions, audit)
│   ├── api.py                       # DRF views (mounted at /plugin/storage-layout/api/v1/)
│   ├── urls.py                      # plugin URL patterns
│   ├── tasks.py                     # Django-Q2 task entry points + bounded watchdog
│   ├── wled.py                      # WLED adapter, SSRF origin policy, transports
│   ├── migrations/                  # additive plugin migrations
│   ├── static/                      # compiled frontend bundle (Vite manifest)
│   └── tests/                       # plugin test suite
└── frontend/                        # React/Vite source for the designer bundle
```

The plugin is distributed as a package and discovered through the
`inventree_plugins` entry point group, so it must be installed into the
InvenTree environment:

```bash
pip install -e src/plugins/storage_layout
```

## Deployment

The plugin uses `AppMixin`, so it contributes Django models and migrations.
Enabling a plugin is **not** a migration strategy:

1. Stop the hardware service (if any) and back up the database.
2. Install the plugin package into the InvenTree environment.
3. Enable the required feature gates (see below).
4. Activate the plugin (`storage-layout`).
5. Run `invoke migrate` (the plugin app must be registered first). This applies
   the additive plugin migrations `0001`–`0003`.
6. Collect the frontend assets: `python manage.py collectplugins` (or
   `invoke static`). This copies `static/` into
   `STATIC_ROOT/plugins/storage-layout/`.
7. Restart the web server **and** the background worker.

Disabling the plugin does not drop its tables. Rollback is package-only while
the schema stays compatible; the plugin migrations must not be reversed
destructively.

### Required feature gates

| Gate | Needed for |
|---|---|
| `ENABLE_PLUGINS_APP` | Registering the plugin's Django models/migrations |
| `ENABLE_PLUGINS_URL` | Serving the REST API under `/plugin/storage-layout/` |
| `ENABLE_PLUGINS_INTERFACE` | Routes and the stock-location panel in the UI |
| `ENABLE_PLUGINS_SCHEDULE` | The scheduled reconciliation watchdog |

These default off and must be enabled in addition to global plugin activation.

### Plugin settings

| Setting | Default | Effect |
|---|---|---|
| `ENABLE_HARDWARE` | `False` | Master gate for **any** live controller access. While false, every live operation fails closed with `live_unavailable`. |
| `DISPATCHER_ENABLED` | `False` | Explicit live dispatcher opt-in; output additionally requires a running worker and a watchdog heartbeat less than 15 seconds old. |
| `HARDWARE_NETWORK_ALLOWLIST` | `''` (deny-all) | Comma-separated approved inventory-VLAN CIDRs or `host:port` entries. Controller origins outside this list are rejected (SSRF boundary). |
| `ARM_DURATION_MINUTES` | `15` | Maximum lifetime of an operator hardware approval. |
| `MAX_CONTROLLERS_PER_CABINET` | `5` | Operational limit only; the schema imposes no limit. |
| `AUDIT_RETENTION_DAYS` | `90` | Daily operational-audit cleanup; unresolved cabinets are preserved. Zero disables pruning. Historical sessions/mappings are retained. |
| `WATCHDOG_ENABLED` | `True` | Run the bounded reconciliation sweep. |

## Hardware safety

Live hardware access is defensively layered and **off by default**:

- `ENABLE_HARDWARE=False` (default) makes `require_live_adapter()` raise before
  any socket is opened, for arm / observe / discover / locate / test.
- An empty `HARDWARE_NETWORK_ALLOWLIST` is a **deny-all** origin policy: the
  adapter refuses to contact any controller until an operator supplies an
  allowlist. The allowlist rejects loopback, link-local, multicast,
  unspecified and reserved addresses (including IPv4-mapped IPv6 variants), and
  never follows redirects or inherits an environment proxy.
- Live locate/test additionally requires an explicit, time-bounded **arm** bound
  to the mapping and configuration fingerprints, plus `approve_live:true`.
- The default frontend/engine path is **simulation**: the same translator,
  validation and session state machine run with an injected fake transport and
  perform no network I/O.

The design document (§10, §16) is explicit that a successful HTTP response does
not prove hardware behaviour and that commissioning, firmware, electrical limits
and physical calibration are **human, owner-authorised** activities. Those gates
remain open; nothing in this repository has been commissioned or approved for
live operation.

## Asynchronous queue

Live and read work is dispatched to the InvenTree background worker via
Django-Q2 (`InvenTree.tasks.offload_task`):

- A durable row (`LocateSession`, `HardwareReadJob`) is committed **before**
  dispatch; the task ID is stored on that row.
- If the queue cannot accept the task, the durable row is marked failed and the
  request is rejected with HTTP 503 `queue_unavailable` — the plugin never
  accepts an untracked live request.
- Live output fails closed unless `DISPATCHER_ENABLED` and `WATCHDOG_ENABLED`
  are enabled, a worker is detected, and the shared cache contains a watchdog
  heartbeat less than 15 seconds old. Use a shared Redis/Memcached cache for
  separate web/worker processes. Simulation also requires a working queue.
- Tasks atomically claim pending rows and recheck actor permissions, ownership,
  mapping/revision, target location and request expiry before execution. Duplicate
  deliveries cannot re-drive an already claimed operation. Apply and clear are
  serialized by a cabinet database write lock, including on SQLite.
- Operational limitation: there is a single logical hardware writer. No database
  lease can fence a paused process at the WLED device, so a second dispatcher
  must not be started until the previous one is confirmed terminated.

## Watchdog

`ScheduleMixin` registers a periodic `reconcile` task (django-q schedules at
minute granularity). Because a five-second sweep is required, the scheduled task
starts a **bounded loop**: it sweeps every 5 seconds for at most 55 seconds and
then exits. A shared-cache lock suppresses duplicate watchdog loops (a local-memory
cache cannot coordinate processes). Database write locks serialize actual apply
and clear operations even if scheduling overlaps. The sweep expires stale sessions,
clears expired arms and releases abandoned reservations. It is skipped entirely
when `WATCHDOG_ENABLED` is false, and no-ops harmlessly when hardware is
disabled.

## Frontend assets and build

The designer bundle is built with Vite from `frontend/`:

```bash
cd src/plugins/storage_layout/frontend
npm install
npm run build          # tsc --noEmit && vite build -> ../storage_layout/static
```

- The build emits a hashed entry (`storage_layout-<hash>.js`) plus
  `.vite/manifest.json`. `InvenTreePlugin.plugin_static_file` resolves
  `storage_layout.js:RenderCabinetList` (etc.) through that manifest.
- `python manage.py collectplugins` (or `invoke static`) copies the assets into
  `STATIC_ROOT/plugins/storage-layout/` for serving.
- The compiled files are shipped with the package through the explicit
  `[tool.setuptools.package-data]` entry in `pyproject.toml` (`static/` is not a
  Python package).
- Build safety: layout editing, mapping preview/publish, import and ordinary
  GETs never touch hardware. The bundle talks only to
  `/plugin/storage-layout/api/v1/`; no controller credentials are placed in JS
  or local drafts.

See [`frontend/README.md`](frontend/README.md) for the public UI declarations,
the socket-free Playwright harness and the reconciled API contract.

## Tests

The plugin must be installed into the environment before its tests can run (the
plugin app is only registered once the package is discoverable):

```bash
pip install -e src/plugins/storage_layout
```

```bash
# From src/backend/InvenTree, using the installed backend environment:
INVENTREE_PLUGINS_ENABLED=true INVENTREE_PLUGIN_TESTING_SETUP=true \
  python manage.py test storage_layout.tests --keepdb \
  --exclude-tag migration_test --settings=storage_layout.test_settings
```

`storage_layout.test_settings` registers the app before test collection, independent
of saved database/plugin state. It also enables entry-point discovery so the
registration and native-validation integration tests exercise the real plugin.
Use a disposable development SQLite database or isolated test database, never a
live database. The backend environment must have its normal requirements installed.

Migration tests run without `--keepdb` (they manipulate the schema):

```bash
INVENTREE_PLUGINS_ENABLED=true INVENTREE_PLUGIN_TESTING_SETUP=true \
  python manage.py test storage_layout.tests.test_migrations --tag migration_test \
  --settings=storage_layout.test_settings
```

Frontend unit/type/lint checks and the browser harness are documented in
[`frontend/README.md`](frontend/README.md).

## Scope

Implemented: plugin-owned geometry/electrical/mapping models and migrations,
the authoritative validation module, the pure translator, the REST API, the
transactional services (compare-and-swap, sessions, audit), the WLED adapter and
SSRF boundary, and the cabinet/drawer designers. Simulation is fully functional;
live operation remains gated behind explicit operator enablement and human
commissioning. Ownership filtering and actor-scoped read jobs are implemented.
Discovery is explicitly bounded to saved controller origins (simulation or an
explicit live controller-ID list), not an autonomous network scan. Calibration
supports single pixels, ranges and finite walking tests (at most 32 logical
pixels within the test profile's maximum ten-second duration). Each live walking
step confirms clear before advancing; simulation exposes ordered timing frames. Cross-database
race/upgrade qualification, real host end-to-end acceptance and physical
commissioning remain release qualifications; see the design document.
