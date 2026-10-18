# Storage Layout & WLED — live-test readiness

This document is the operator-facing readiness record for the Storage Layout &
WLED plugin. It states what is verified, what is not, and the exact, staged,
human-supervised procedure for the first live hardware test. **No live hardware
has been accessed, armed or commanded in producing this document.** Every
automated check below runs against the simulation transport or an in-memory
fixture and performs no network I/O to a controller.

Baseline for this record: `development/my-inventree` at
`9e3de6dd4fc67fd4bc0312552299125c826a8cc6` (start of Checkpoint 002J).

---

## 1. What works (verified)

| Area | Status | Evidence |
|---|---|---|
| Plugin install / enable / migrate | Working + tested | `storage_layout/tests/test_plugin.py`, `test_migrations.py` |
| Permissions, actor/ownership scoping | Working + tested | `test_api.py::PermissionTests`, `OwnershipApiTests`, `test_services.py` |
| Cabinet create/edit/archive + native `StockLocation` binding | Working + tested | `test_api.py::CabinetApiTests` (incl. archive), `test_plugin.py::NativeLocationGuardTests` |
| Drawer/bin create/edit/move/resize/duplicate/archive, collisions, CAS/ETag | Working + tested | `test_api.py::LayoutApiTests`, `test_services.py::LayoutServiceTests` |
| Controller/output/string topology + validation | Working + tested | `test_validation.py`, `test_wled.py::CapabilityTests`, `test_api.py::ElectricalApiTests` |
| Logical→physical translation (forward/reverse, multi-controller, split output, gaps, overlaps, partial ranges) | Working + tested | **shared fixture** `shared/mapping_fixtures.json` consumed by `test_mapping_fixtures.py` **and** `frontend/tests/mapping-fixtures.test.ts` |
| Mapping preview / publish / revision / hash / stale handling | Working + tested | `test_services.py::MappingServiceTests`, `test_api.py::MappingApiTests`, e2e `designers.spec.ts` |
| Replacement drawer allocations on publish | Working + tested | `test_services.py::test_publish_applies_replacement_allocations` |
| Function colours (locate/test/reserved profiles) | Working + tested | `frontend/src/components/editor/FunctionColorsPanel.tsx`, `tests/function-colors.test.tsx`, e2e `designers.spec.ts` |
| Simulation-only identify/test (single LED, range, walk, stop/clear) | Working + tested | `test_services.py::SessionServiceTests`, e2e `designers.spec.ts` |
| Locate by drawer/bin/location/item; session lifecycle | Working + tested | `test_services.py::SessionServiceTests` (incl. item target), `test_ui.py` |
| Hardware safety gates (ENABLE_HARDWARE, dispatcher, allowlist, arm, watchdog, emergency stop, clear-on-failure) | Working + tested | `test_plugin.py`, `test_services.py::LiveSessionTests`, `test_wled.py::OriginPolicyTests` |
| Out-of-range physical addressing interlock | Working + tested | `wled.validate_pixel_bounds` + `test_wled.py::PixelBoundsTests`; publish-time output bound in `validation.validate_mapping_spans` |
| Simulation performs no network I/O | Working + tested | `test_wled.py::test_no_socket_is_opened` (monkeypatches `socket.create_connection`/`getaddrinfo` to raise) |

### Verified commands and results

Backend (disposable SQLite test DB; never a live DB):

```bash
cd src/backend/InvenTree
INVENTREE_DB_ENGINE=sqlite INVENTREE_DB_NAME=/tmp/inv-test/db/test.sqlite3 \
INVENTREE_STATIC_ROOT=/tmp/inv-test/static INVENTREE_MEDIA_ROOT=/tmp/inv-test/media \
INVENTREE_BACKUP_DIR=/tmp/inv-test/backup \
INVENTREE_PLUGINS_ENABLED=true INVENTREE_PLUGIN_TESTING_SETUP=true \
  python manage.py test storage_layout.tests --keepdb \
  --exclude-tag migration_test --settings=storage_layout.test_settings
# -> Ran 513 tests ... OK
```

Frontend unit/component tests, typecheck and lint:

```bash
cd src/plugins/storage_layout/frontend
npm test          # -> 285 passed (14 files)
npm run typecheck # -> clean
npm run lint      # -> clean
```

Browser integration (socket-free Playwright harness, real built bundle):

```bash
cd src/plugins/storage_layout/frontend
npm run e2e       # -> 22 passed
```

## 2. Explicitly unverified

- **Real host end-to-end acceptance** (a live InvenTree web + worker process pair
  against a real database) has not been run in this environment.
- **Physical commissioning**: firmware, wiring, power/current limits, brightness
  calibration and optical verification are human, owner-authorised activities
  and have not been performed.
- **Cross-database race/upgrade qualification** (PostgreSQL/MySQL concurrency,
  migration upgrade from an older schema) is not exercised here.
- **Reachability diagnostics**: the `OFFLINE`/`DRIFTED`/`QUARANTINED` controller
  states and the `ARM_PREFLIGHT` read job are defined in the schema but are not
  currently written by any code path; there is no dedicated reachability-probe
  endpoint. Treat controller reachability as an operator-observed precondition.
- **Per-function colour taxonomy**: the product schema models `locate`, `test`
  and `reserved` purposes only. Separate colours for locate-drawer vs
  locate-bin, selection/identification, warning/error and idle/clear are **not**
  modelled and are recorded as owner-input requirements rather than invented
  fields.
- **Pixel-test controller/output/string selection**: a pixel test takes a
  logical range and derives the controller/string runs from the active mapping;
  there is no endpoint to pick a controller/output/string directly.

## 3. Reproducible local setup (disposable development instance)

```bash
# 1. Install the plugin package into the InvenTree environment.
pip install -e src/plugins/storage_layout

# 2. Enable the feature gates (development settings only):
#    ENABLE_PLUGINS_APP, ENABLE_PLUGINS_URL, ENABLE_PLUGINS_INTERFACE,
#    ENABLE_PLUGINS_SCHEDULE, INVENTREE_PLUGINS_ENABLED=true

# 3. Activate the plugin (`storage-layout`) and migrate.
cd src/backend/InvenTree
python manage.py migrate

# 4. Build and collect the frontend assets.
cd ../../plugins/storage_layout/frontend && npm install && npm run build
cd ../../../backend/InvenTree && python manage.py collectplugins

# 5. Restart the web server AND the background worker.
```

Smoke test (no hardware): open `/web/plugin/storage-layout/cabinets`, create a
cabinet, add drawers/bins, configure a controller/output/string on the
**Topology** tab, map and publish on the **Mapping** tab, set colours on the
**Colors** tab, and run a simulated locate/test on the **Diagnostics** tab.

## 4. Safe sample topology and expected results

The canonical fixture `shared/mapping_fixtures.json` (`two_controllers`) is the
reference topology:

| Controller | Output | `wled_start` | `pixel_count` | String | `output_offset` | `pixel_count` |
|---|---|---|---|---|---|---|
| `ctrl-a` | `out-a0` | 0 | 100 | `str-a0` | 0 | 60 |
| `ctrl-a` | `out-a0` | 0 | 100 | `str-a1` | 60 | 40 |
| `ctrl-a` | `out-a1` | 200 | 50 | `str-a2` | 0 | 50 |
| `ctrl-b` | `out-b0` | 10 | 40 | `str-b0` | 0 | 40 |

Example mapping (logical 1..140) and expected LED runs (zero-based, half-open
`[wled_start, wled_stop)`):

| Logical span | String | Direction | Expected run |
|---|---|---|---|
| 1–60 | `str-a0` | forward | `ctrl-a/out-a0/str-a0` `[0, 60)` |
| 61–100 | `str-a1` | forward | `ctrl-a/out-a0/str-a1` `[60, 100)` |
| 101–140 | `str-b0` | forward | `ctrl-b/out-b0/str-b0` `[10, 50)` |

A reversed span on `str-a2` (logical 1–50, `string_offset` 0, direction −1)
maps to `ctrl-a/out-a1/str-a2` `[200, 250)`; logical pixel 1 → WLED index 249.

Function colours (via the **Colors** tab, stored as locate profiles):

| Purpose | Example colour | Brightness | Duration |
|---|---|---|---|
| locate | `rgb(0, 255, 0)` | 64 | 120 s |
| test | `rgb(0, 0, 255)` | 32 | 10 s |
| reserved | `rgb(255, 128, 0)` | 16 | 30 s |

Simulation expected outcomes (no hardware):

- Locate drawer → session `queued` → `active`; plan runs match the table above.
- Single-pixel test (logical 1–1) → one run `[0, 1)`.
- Walking test (logical 1–3) → three ordered frames; bounded to 32 pixels.
- Stop/clear → session `stopped`; `clear_status` reported.
- An out-of-range run (e.g. `[0, 130)` against a 120-LED device) is rejected
  with `out_of_range` before any write.

## 5. Hardware prerequisite checklist (owner/operator)

- [ ] WLED device type and firmware confirmed against `FIRMWARE_TARGET`.
- [ ] WLED LED configuration (count, type, colour order, GPIO) matches the
      saved topology; no matrix/ledmap transforms.
- [ ] Controller IP/port recorded and reachable on the isolated inventory VLAN.
- [ ] `HARDWARE_NETWORK_ALLOWLIST` set to the exact controller `host:port`/CIDR;
      loopback/link-local/multicast/reserved addresses remain rejected.
- [ ] Power supply and current limits verified; `max_current_ma` set.
- [ ] Physical pixel count and per-output offsets confirmed on the device.
- [ ] Safe brightness cap agreed (start ≤ 32).
- [ ] Operator holds `configure_hardware` / `operate_hardware` /
      `emergency_stop` permissions.
- [ ] Background worker running; `DISPATCHER_ENABLED` and `WATCHDOG_ENABLED`
      enabled; shared cache (Redis/Memcached) configured for web+worker.
- [ ] Database backed up; rollback plan agreed.
- [ ] Emergency-stop procedure and physical power isolation rehearsed.
- [ ] Single logical hardware writer confirmed (no second dispatcher running).
- [ ] Owner approval recorded for the supervised session.

## 6. Supervised live test runbook (human-executed, fail-closed)

Each step is executed by a person. Stop on any unexpected result.

1. **Default-off verification.** With `ENABLE_HARDWARE=False`, attempt a live
   locate; confirm it fails closed with `live_unavailable` and no socket opens.
2. **Simulation pass.** Run the sample topology locate/test in simulation;
   confirm the plan runs match §4 and the session stops/clears.
3. **Reachability/observe.** Enable `ENABLE_HARDWARE`, set the allowlist, and
   observe the controller. Confirm the reported LED count matches the saved
   topology. Do not illuminate yet.
4. **Arm with a short expiry.** Arm the cabinet for a few minutes; confirm the
   arm is bound to the mapping/config fingerprints.
5. **One pixel at low brightness.** Send a single-pixel test (logical 1) at
   brightness ≤ 32. Confirm exactly one LED lights and the device backup timer
   is armed.
6. **Clear/stop.** Stop the session; confirm the strip clears.
7. **One drawer.** Locate a single drawer; confirm the expected run lights.
8. **Multi-output only after verification.** Only after steps 1–7 pass, test a
   mapping spanning two outputs/controllers.

Pass/fail: any out-of-range address, unconfirmed clear, or unexpected
illumination is a **fail**; power the strip down and stop.

## 7. Evidence commands (credentials redacted)

```bash
# Plugin/backend test evidence
python manage.py test storage_layout.tests --keepdb --exclude-tag migration_test \
  --settings=storage_layout.test_settings

# Frontend evidence
cd src/plugins/storage_layout/frontend && npm test && npm run typecheck && npm run lint && npm run e2e

# No-network evidence (simulation)
python manage.py test storage_layout.tests.test_wled.SimulationTests.test_no_socket_is_opened \
  --settings=storage_layout.test_settings

# Worker/watchdog logs (redact controller credentials and allowlist entries)
journalctl -u inventree-worker --since "1 hour ago" | grep -i storage_layout
```

## 8. GO / NO-GO

| Dimension | Status | Basis |
|---|---|---|
| Software simulation-ready | **GO** | 513 backend + 285 frontend + 22 browser tests pass; shared mapping fixture parity; no-network test passes |
| Environment-ready | **NO-GO (unverified)** | Real host web+worker E2E not run in this environment |
| Hardware-ready | **NO-GO (unverified)** | No commissioning performed; reachability diagnostics incomplete |
| Operator-approved | **NO-GO (pending)** | Owner approval and the §5 checklist are outstanding |

**Overall: NO-GO for unsupervised live operation.** The software is ready for a
**supervised** first live test once the §5 checklist is complete and a person
executes the §6 runbook. Hardware readiness must not be claimed until a person
performs commissioning.
