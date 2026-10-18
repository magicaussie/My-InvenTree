# Storage Layout & WLED — live-test readiness

This document is the operator-facing readiness record for the Storage Layout &
WLED plugin. **Checkpoint 002J-D has now sent authorised temporary lighting
commands to both real controllers through Django HTTP and the normal worker.**
Eight single-pixel boundary tests, drawer locate and bin-native-location locate
reached active execution. Captured runtime fields were restored and read back on
both controllers; persistent configuration hashes were unchanged. This is real
controller protocol evidence, not optical verification. String identity, direction
and visible output remain pending owner observation. Browser E2E remains
fixture-backed; it did not drive Django.

Baseline for this record: `development/my-inventree` at
`9e3de6dd4fc67fd4bc0312552299125c826a8cc6` (start of Checkpoint 002J).

---

## Checkpoint 002J-D result (2026-10-18 UTC)

- Restored checkout on the separate New Volume1 filesystem, based on
  `f118c6a4c655173d798788eaa6b75e1b9618a5ab`; original recovery archive untouched.
  Historical edits already present in that baseline were retained, not replayed
  over newer code. New restoration code is a reviewed implementation, not a claim
  of byte-identical recovery of the deleted worktree.
- Adapter commissioning `capture_state` / `restore_state` now preserve writable
  runtime fields with read-back confirmation. Frozen individual-pixel snapshots
  are rejected because their per-pixel colours cannot be read back. Effect phase
  and elapsed nightlight time are not recoverable. Normal session stop remains
  explicitly off/black/unfrozen; commissioning restoration is a separate finally
  operation, not automatic restoration on every production stop.
- Fixed the observed stop/watchdog-expiry race: a completed terminal session is
  accepted idempotently without clearing a newer session's controller output.
  Master-on ambiguity/read-back failure now triggers adapter failure cleanup.
- Fresh regression: **527 tests run, OK, one skipped**; **6 migration tests OK**;
  migration consistency check found no changes. Focused adapter/service tests:
  **228 tests, OK**. Normal Git hooks must pass before
  publication. No frontend changes; previous frontend counts below are historical.
- Real Django HTTP + qcluster simulation: **56 HTTP requests passed**, including
  cabinet/drawer/bin creation, layout updates, mapping preview/publish, colours,
  diagnostics and expected permission/revision/validation rejections.
- Shared cache: standard Django `FileBasedCache`, same absolute location in web
  and worker. A separate process read the worker watchdog heartbeat. SQLite's
  default single worker starved observation jobs behind the long watchdog loop;
  this disposable setup explicitly used two workers, a separate queue name,
  timeout 300 seconds and retry 450 seconds. This is not production SQLite
  concurrency qualification. Production configuration was not changed. A stale
  disposable watchdog lease was removed only after its prior processes stopped.
- Real WLED tests: brightness **8/255**, red, two-second duration; first and last
  pixel of each of the four configured buses reached active execution. Stop or
  expiry confirmed off/nightlight disabled. Later drawer and bin-location locate
  used green `[0,24,0]`, brightness 8 and two-second duration; both reached active
  and stopped. A literal `bin` target is not an API choice: bin locate uses its
  native stock-location binding and the existing drawer allocation.
- Commissioning finally restored both captured controller states, including
  master-on, brightness 128, nightlight settings and unfrozen black segment state.
  Full `/json/cfg` hashes matched before and after; no presets, persistent config,
  firmware or network settings were written. Bus table and optical limitations:
  [hardware reference](../../../docs/hardware/WLED_CONTROLLERS.md).
- Private evidence stays outside Git in
  `/media/spetchal/New Volume1/My-InvenTree-reconciliation-002JD/`:
  `runtime/eight-boundary-tests-evidence.json`,
  `runtime/authorized-live-evidence.json`, `runtime/adapter-restoration-results.json`,
  `runtime/heartbeat-evidence.json`, `runtime/focused-tests.log`,
  `runtime/regression-tests.log`, `runtime/migration-tests.log`, and
  `http-regression/http-evidence.json`. Earlier failed attempts are retained,
  including the fixed stop race and an expected rate-limit rejection; they are
  not relabelled as passing runs.

**Independent review gate:** no merge/deployment. Optical string assignment,
direction and visible correctness are not established by acknowledgements.

### Historical 002J-C result (superseded where noted above)

> **Historical 002J-C revised-policy result (2026-10-18): backend simulation gates
> PASS; hardware/live operation remains NO-GO.** Backend plugin suite: 520 passed;
> migration tests: 6 passed; migration consistency check passed. Frontend: 290 tests
> passed, lint checked 46 files, typecheck and build passed, and 25 fixture-backed
> Chromium E2E tests passed. The pinned Ruff 0.15.12 `check --preview` and
> `format --check --preview` both passed on all three changed backend Python files.
> Normal configured `prek run` passed all applicable hooks, including pinned
> Ruff preview, codespell, secret detection and teyit; no hooks were bypassed.
> External HTTP distinct-drawer overlap returned 400 `allocation_overlap` with
> unchanged layout, allocations and ETag `"7"`; see the final evidence section.
> A real localhost Django HTTP + qcluster simulation passed 55 assertions; evidence
> is in `/tmp/inventree-http-002jc/` (`RESULTS.md`). This is not browser-against-Django
> acceptance or hardware testing. Read-only controller discovery is documented in
> `docs/hardware/WLED_CONTROLLERS.md`. Hardware writes remain pending a safe restore
> mechanism and verified physical string-to-bus mapping; no hardware settings or
> visible state were changed. Historical 002J-C sections below remain historical
> unless explicitly superseded by this status.

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
| Simulation-only identify/test (single LED, range, walk, stop/clear) | Working + tested | `test_services.py::SessionServiceTests`, fixture-backed e2e `designers.spec.ts`; current real localhost HTTP + qcluster simulation in `/tmp/inventree-http-002jc/` |
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
npm test          # -> 290 passed (frontend agent reported; not rerun by C)
npm run typecheck # -> clean
npm run lint      # -> clean
```

Browser integration (socket-free Playwright harness, real built bundle):

```bash
cd src/plugins/storage_layout/frontend
npm run e2e       # -> 25 passed (Luna reran; not rerun by this pass)
```

## 2. Explicitly unverified

- **Real browser acceptance** against the disposable host has not been run.
  Real HTTP-client + worker + persistent SQLite acceptance passed in §9; this
  is not browser E2E, production deployment qualification or hardware testing.
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
| Software simulation-ready | **GO (current 002J-C revised-policy checks)** | 520 backend + 6 migration tests; consistency check; 290 frontend tests, lint (46 files), typecheck, build and 25 fixture-backed Chromium E2E; pinned Ruff 0.15.12 preview checks passed; real localhost HTTP + qcluster simulation passed 55 assertions |
| Environment-ready (disposable simulation) | **GO for verified localhost simulation only** | Fresh 55-assertion HTTP + worker simulation; this is not browser-against-Django or production qualification |
| Hardware-ready | **NO-GO (unverified)** | Read-only controller configuration observed; safe app-mediated restore and physical string-to-bus/optical mapping remain unverified; no commissioning performed |
| Operator-approved | **NO-GO (pending)** | Owner approval and the §5 checklist are outstanding |

**Overall: NO-GO for live operation pending owner-provided environment/origin, known wiring/mapping, optical verification, owner approval and commissioning.**
The disposable API-level simulation path passed; that does not authorize even
supervised hardware activation. The 002J-C results include real localhost HTTP
and qcluster simulation, but fixture-backed browser E2E only—not a browser session
against Django. The §5 checklist, explicit owner approval and
human execution of §6 remain mandatory.

## 9. Checkpoint 002J-C — actual disposable-host acceptance

Executed 2026-10-18 on `development/my-inventree`, HEAD
`4697739448f458eebe31c446f734a6549b072ea9` with the owner's authorized,
uncommitted A/B work preserved. C changed only this record and
`src/plugins/storage_layout/acceptance_real_host.py`. No commit or push.

### Reproduction and isolation

From the repository root:

```sh
/tmp/inv-venv/bin/python src/plugins/storage_layout/acceptance_real_host.py
# EVIDENCE_DIRECTORY=/tmp/storage-layout-002jc-_u2m9o6r
# PASS: real HTTP + Django-Q simulation; inspect http.json and sessions.json
# exit 0
```

The helper uses the existing environment; installs nothing. Every run creates
its own `/tmp/storage-layout-002jc-*` SQLite DB, file cache, static/media/backup
paths and settings derived from `storage_layout.test_settings`. It migrates
that disposable DB, activates the plugin and required integration gates, seeds
native locations and a disposable superuser/session, then sends authenticated
HTTP requests with session cookie and CSRF token through the actual middleware
and plugin URL registration. It does not use Django's test client or mock the
queue/service/adapter. Authentication bootstrap is ORM-seeded; interactive
login is not tested. Credentials are not included in the HTTP evidence, and the
bootstrap credential file is removed in `finally`.

`manage.py runserver 127.0.0.1:18763 --noreload` and `manage.py qcluster` run as
supervised child process groups. Management commands have 180-second timeouts,
HTTP requests 10 seconds, server readiness 30 seconds and session polling 20
seconds. Cleanup sends TERM and waits eight seconds before KILL. The terminal
invocation was also bounded to 240 seconds. No server/worker is left running.
Django-Q uses its real ORM broker, `sync=False`, one worker, persistent task
results and shared file cache. Unrelated migration-seeded queued jobs/schedules
are removed **only from this disposable DB** before starting the worker.

Persisted plugin gates were asserted: `ENABLE_HARDWARE=False`,
`DISPATCHER_ENABLED=True` for asynchronous simulation dispatch,
`HARDWARE_NETWORK_ALLOWLIST=''`. Watchdog defaults are not disabled; scheduled
watchdog expiry/recovery is not qualified by this run. A denied live request
returns HTTP 503 `live_unavailable` without enabling hardware.

A generated `sitecustomize.py` in every backend/worker Python process intercepts
`socket.socket.connect`, `connect_ex` and `sendto`, records and raises before
any IP connection/send. Unix-domain multiprocessing IPC remains permitted.
The external acceptance client talks only to the literal loopback host/port.
Controller origin is documentation-only `http://192.0.2.1`. Final run has **zero
intercepted attempts** (`sockets.jsonl` absent), hence zero controller connection
attempts through these Python socket paths. This is Python interception, not an
OS firewall or proof about arbitrary native-code networking.

### Actual results and durable evidence

Historical evidence directory: `/tmp/storage-layout-002jc-_u2m9o6r` (local,
ephemeral, not committed; contains disposable DB/session data—do not publish).

| Check | Observed evidence |
|---|---|
| HTTP backend | 54 requests in `http.json`; anonymous request 401; authenticated real plugin responses |
| Cabinet/drawer/bin | Cabinet create/read/edit/archive; two native-bound drawers and bin create/read/edit; bin/drawer archive (domain deletion semantics) |
| Electrical topology | Actual PUT creates controller → 120-pixel output → string; authoritative IDs used immediately in preview/publish |
| Mapping | Preview 200; publish 201; revision/ETag advances; adjacent allocations 1–60 and 61–120 accepted |
| Negative CAS | Cabinet stale update and stale publication both 412 `stale` |
| Negative integrity | Out-of-range allocation 400 `invalid_bounds`; duplicate replacement 400 `invalid_reference`; replacement 60–70 vs retained 61–120 rejected 400 `allocation_overlap`; duplicated mapping spans rejected 400 `mapping_gap`; out-of-range pixel test 400 `invalid_bounds` |
| Atomicity | Layout GET payload and ETag identical before/after duplicate/overlap rejection group |
| Saved/reloaded/selected locate | RGB `[17,83,149]`, brightness 37, duration 30 seconds; saved profile ID explicitly sent and frozen values asserted |
| Saved/reloaded/selected test | RGB `[203,41,7]`, brightness 19, duration 7 seconds; saved profile ID explicitly sent and frozen values asserted |
| Real worker | Two `storage_layout.tasks.run_session_task` durable Django-Q results with `success=1`; heartbeat task also succeeds |
| Lifecycle | Both HTTP create responses 202 `queued`; HTTP polling observes `active`; stop 202 then GET `stopped`; executions `cleared`, `clear_status=not-required` (simulation, not physical clear acknowledgement) |
| Persistent sessions | `sessions.json` and SQLite rows: locate `3ae3ed51-8076-4bfb-9604-f5995e2ad422`, pixel test `e4571042-340f-4bfe-bff6-5c2464f731e3`; both stopped with exact frozen profiles |
| No controller sockets | No socket-attempt log in final run; backend/worker guard loaded through inherited PYTHONPATH |

Evidence files: `command-migrate.log`, `command-shell.log`, `web.log`,
`worker.log`, `http.json`, `sessions.json`, `db.sqlite3`, generated settings and
socket guard. Earlier setup attempts failed on site URL, plugin activation,
authentication/gates, required native binding and helper assumptions about
response shapes/statuses; these were helper setup corrections, not service
changes. An earlier complete lifecycle run at
`/tmp/storage-layout-002jc-pm5f3m38` failed the zero-attempt assertion because a
pre-seeded **currency exchange** background job attempted external HTTPS; the
guard blocked it before connection. Final isolation removes those unrelated
seeded jobs; it does not loosen the guard.

Existing built frontend bundle was present:
`storage_layout/static/storage_layout-Cqf9AOyz.js`, 120335 bytes, SHA-256
`3559928ddc9259122cefc389f1641f9c64f483442c879e016185a1753219ea5b`.
Frontend agent reported its build passed; C did not rebuild or drive that bundle
in a browser. Historical unit/browser totals in §1 are not new C test results.
`git diff --check` passed after C changes.

**Historical disposition: GO for the earlier disposable HTTP + persistent
worker simulation path. Final review disposition: NO-GO pending a successful
post-quality-fix real-host rerun; NO-GO for browser acceptance, production
qualification, hardware commissioning or operator authorization.** Not exercised here: real-browser
state transitions, walk-pattern timing, automatic expiry/watchdog recovery,
physical bounds errors against a real device, PostgreSQL/MySQL concurrency,
interactive login, or real hardware. Existing focused tests are not substitutes
for those unperformed checks.

### Final helper quality review and rerun attempt (2026-10-18)

Fixed helper import ordering, four public-function docstrings, unused publication
response binding and unnecessary `dict()` constructors; applied repository Ruff
formatting. Only the acceptance helper and this document were edited by C during
this review; authorized dirty frontend/backend work was preserved.

Using existing `/home/spetchal/.local/bin/ruff`, from repository root:

```sh
ruff check src/plugins/storage_layout/acceptance_real_host.py
# All checks passed!
ruff format --check src/plugins/storage_layout/acceptance_real_host.py
# 1 file already formatted
/tmp/inv-venv/bin/python src/plugins/storage_layout/acceptance_real_host.py
# /bin/sh: 2: /tmp/inv-venv/bin/python: not found
# exit 127
```

Ruff emits existing configuration warnings that DOC402/DOC403 require preview;
these are not helper violations. No dependencies were installed. The prescribed
Python environment is absent, the current shell Python cannot import Django,
and `/tmp/storage-layout-002jc-*` evidence directories are absent in this review
environment. Thus the preceding 54-request/session/worker/socket results remain
a historical record, not independently revalidated final-run evidence. This
attempt started no backend or worker and provides no new socket/lifecycle proof.
Restore the previously provisioned InvenTree environment, then rerun the command
above under a 240-second supervisor and inspect fresh persisted evidence before
acceptance can be GO again; dependency installation requires owner approval.

### Resumed independent verification (2026-10-18)

Verified branch `development/my-inventree`, local HEAD, tracking ref and GitHub
branch tip all equal the required baseline
`4697739448f458eebe31c446f734a6549b072ea9`. Existing checkpoint changes were
preserved; `ZED_ACTIVE_TASK.md` remains untracked and excluded from delivery.

Independent frontend review found another draft-loss path: mapping publication
refreshes the layout even when the layout has unsaved changes. Mapping is now
read-only while the layout is dirty, matching the existing topology save gate.
A new browser regression fails without this guard (Publish mapping enabled),
then passes after restoration; it checks retained drawer position and subsequent
layout save. This proves prevention, not execution of a destructive publication.

Fresh final commands in `src/plugins/storage_layout/frontend`:

| Command | Result |
|---|---|
| `npm test` | 290 passed, 15 files |
| `npm run typecheck` | Passed |
| `npm run lint` | Biome: 46 files checked, passed |
| `npm run e2e` | 25 Chromium tests passed, fixture API only |
| `npm run build` | Catalog compilation, TypeScript and Vite passed |

Ruff check and format check passed for `services.py`, `test_services.py` and
`acceptance_real_host.py`; the two backend files were formatted using the
installed Ruff. `git diff --check` passed. Ruff emits existing DOC402/DOC403
preview-configuration warnings.

Independent backend verification found no usable Django environment among 41
existing Python interpreter candidates. Both plugin and migration commands fail
before discovery with `ModuleNotFoundError: No module named 'django'` / INVE-E14:

```sh
# From src/backend/InvenTree; each with the following environment:
# PYTHONDONTWRITEBYTECODE=1 INVENTREE_DB_ENGINE=sqlite INVENTREE_DB_NAME=:memory:
# INVENTREE_PLUGINS_ENABLED=true INVENTREE_PLUGIN_TESTING_SETUP=true
/usr/bin/python3 -B manage.py test storage_layout.tests --keepdb --exclude-tag migration_test --settings=storage_layout.test_settings
/usr/bin/python3 -B manage.py test storage_layout.tests.test_migrations --tag migration_test --settings=storage_layout.test_settings
```

**Zero backend tests executed in this resumed verification.** Real-host helper
launch still fails with exit 127 because `/tmp/inv-venv/bin/python` is absent.
No backend/worker was started, dependencies installed, or physical hardware
accessed. Historical backend and HTTP results above are not fresh verification.

The installed `.git/hooks/pre-commit` also depends on that missing interpreter;
no fallback `pre-commit` executable is on PATH. A normal commit attempt failed
with exit 1: `` `pre-commit` not found. Did you forget to activate your virtualenv? ``.
No commit was created and nothing was pushed; the checkpoint files were unstaged
after the failed attempt. Required hooks must not be bypassed. Restore the approved development environment, run backend tests and
real-host acceptance, then run the hooks before committing/pushing.

**Final disposition: NO-GO / incomplete checkpoint.** Fresh frontend verification
is green; fresh persistent backend/worker acceptance and mandatory commit-hook
execution remain blocked. No claim of hardware readiness or owner approval.
Potential profile reload response-order races and cross-database concurrency
remain unqualified, not reproduced blockers. Stop for independent review.

### 002J-C namespace correction and approved recovery (2026-10-18)

This later run supersedes the missing-environment blocker above, but **does not
supersede the NO-GO disposition**. HEAD remains
`4697739448f458eebe31c446f734a6549b072ea9` on
`development/my-inventree`, tracking `origin/development/my-inventree`. The initial
21 modified tracked / five untracked files were inventoried with SHA-256 before
editing; all existing work was retained. The task file remains excluded.

The original real-launcher failure was reproduced: reopening
`/proc/<launcher>/fd/<namespace-fd>` raised `PermissionError: [Errno 13]`.
Independent probes found ordinary children could reopen the live FD but
bubblewrap children could not, despite matching numeric UID/GID and dumpability
1. The user namespaces differed; capabilities were zero, seccomp disabled and
`attr/current` was `unconfined`. This narrows the failure to procfs/ptrace-style
access checks across user namespaces; an exact kernel/LSM rule was not proven.

The replacement uses a private Unix `SOCK_SEQPACKET` socketpair and `SCM_RIGHTS`,
not a string or environment assertion. Kernel peer/sender credentials and live
ancestry authenticate the control exchange. Both sides validate actual network
namespace FDs using `NS_GET_NSTYPE` and compare device/inode identities. The child
checks only loopback interfaces/routes, zero capabilities and `NoNewPrivs=1`,
then waits for launcher release before site/application execution. Timeouts and
malformed exchanges fail closed; verification FDs are closed before application
startup. Python starts with `-I -S`; bwrap drops all capabilities and closes
unintended descriptors. This proves network isolation under trusted launcher,
bwrap and bootstrap code, not containment of malicious writable code or a
cooperating same-UID host process.

Fresh `python3 -B -m unittest test_acceptance_isolation -v` passed **13 tests**.
Coverage includes actual bwrap entry, fork/exec/spawn namespace inheritance,
kernel `ENETUNREACH` inside the verified route-less namespace, sandbox loopback
HTTP success, host-loopback canary separation, malformed/forged descriptors and
markers, missing release, proxy/DNS/redirect rejection and evidence failures.
No external endpoint was contacted by the kernel-isolation probes.

The approved Python 3.12.3 environment was created at
`/home/spetchal/.local/share/my-inventree-002jc/venv` after verifying it absent.
Both checked-in requirements files were installed entirely from uv's offline
cache with `--require-hashes`; the local plugin was installed editable with
`--offline --no-deps --no-build-isolation`. `uv pip check` passed for 199 packages;
Django 5.2.17 and the editable plugin imported successfully. Pinned prek 0.5.5
was installed by the requirements. The original hook was backed up outside Git
as `pre-commit.original` (SHA-256
`01b2574291a0d246762d6bcf2175067dd5c2e922d03c56ab7a28b224b80aa6f0`).
`prek install` initially retained the broken hook in migration mode; normal
`prek install --force` then replaced it without the broken legacy invocation.
No commit hook was bypassed; a successful complete hook run is still pending.

Fresh independent tests, with private networking and disposable SQLite paths:

| Command / gate | Result |
|---|---|
| `manage.py test storage_layout.tests --keepdb --exclude-tag migration_test --settings=storage_layout.test_settings` | 519 passed |
| `manage.py test storage_layout.tests.test_migrations --tag migration_test --settings=storage_layout.test_settings` | 6 passed; fresh test DB |
| `manage.py makemigrations --check --dry-run --settings=storage_layout.test_settings` | No changes detected |
| `npm test` | 290 passed, 15 files |
| `npm run e2e` | 25 fixture-backed Chromium tests passed (not Django-backed) |
| `npm run typecheck`, `npm run lint`, `npm run build` | Passed; Biome checked 46 files |
| Pinned Ruff 0.15.12 `check --preview` on five changed Python files | Passed |
| Pinned Ruff 0.15.12 `format --check --preview` | Failed: runner, services and service tests require preview formatting; isolation files pass |
| `git diff --check` | Passed |

The real-host runner was corrected to require `DISPATCHER_ENABLED=False`, in
addition to `ENABLE_HARDWARE=False` and an empty allowlist. Invocation:

```sh
/home/spetchal/.local/share/my-inventree-002jc/venv/bin/python -B src/plugins/storage_layout/acceptance_real_host.py
```

**Fresh real-host acceptance failed before HTTP or worker startup**, in the
first guarded `migrate --noinput` child. Evidence is retained outside Git at
`/tmp/storage-layout-002jc-0_ye1tsz/command-migrate.log` and `isolation.jsonl`.
Parent PID 116664 and child PID 116677 recorded the same private namespace
`net:[4026533929]`. The audit records two denied operations:

- `socket.bind` to `('::1', 0)` during dependency initialization;
- `subprocess.Popen` for exactly `['/sbin/ldconfig', '-p']`, invoked by
  WeasyPrint → CFFI → `ctypes.util.find_library` while importing Django models.
  The resulting `IsolationError` terminates migration and the runner exits 1.

These are real acceptance-policy/dependency integration blockers, not a missing
Python dependency or evidence of hardware contact. No allowance was added to
silently ignore blocked audit records or broaden child subprocess permissions.
The task's fail-stop rule applies: the complete HTTP/DB/worker workflow has **not**
passed fresh acceptance, hooks have not passed, and preview formatting remains
pending. No changes were staged, committed or pushed. Historical HTTP evidence
is not substituted for this failed run. **NO-GO; independent review required.**

### Continuation 6 — resolver/probe review and fresh acceptance (2026-10-18)

The new acceptance-isolation resolver/probe and its tests were read and reviewed
independently. Fresh reported focused validation: isolation **16 passed**;
frontend **290 passed** and **25** browser tests passed; typecheck passed;
Biome checked **46 files**; build passed; Ruff format passed for **3** files.
These results do not replace the missing backend, migration or consistency runs
for this continuation.

The real acceptance attempt **failed**. The retained log at
`/tmp/storage-layout-002jc-x3gf2vsp/web.log` shows Django's development server
calling `socket.gethostbyaddr('127.0.0.1')`; the child guard correctly denied
that operation under its current policy, and the web process did not start. The
reported subsequent client result was connection refused. This remains a failed
acceptance, not evidence of a successful HTTP/worker workflow. No fresh backend
519-test run, migration 6-test run, consistency check or complete hooks run is
claimed here. No hardware was accessed. **NO-GO; do not commit or push.**

Security review observations (not changes): the launcher/bubblewrap namespace
and kernel network restrictions provide defense-in-depth network isolation, but
the code explicitly bind-mounts `/` and does not sandbox filesystem access; it
must not be treated as a general-purpose sandbox for untrusted code. Python
`sys.addaudithook` guards are also defense in depth and are bypassable by native
code; the network namespace is the primary network boundary. The ELF resolver
restricts names and checks architecture and location, but its safety depends on
the host library paths and files remaining trusted (path validation is not a
full defense against concurrent filesystem replacement). Keep the trusted
launcher/bootstrap and filesystem assumptions explicit, and do not weaken the
DNS denial or treat this failed acceptance as a pass without separately
reviewing any policy adjustment.

### Current revised-policy verification (2026-10-18)

This fresh backend-only verification was run 2026-10-18 from the specified Python
3.12.3 venv using the existing disposable SQLite configuration at
`/tmp/inventree-http-002jc/config.yaml`. The plugin suite passed **520 tests**
(including the new distinct-drawer overlap API regression); migration tests passed
**6**; `makemigrations --check --dry-run` reported **No changes detected**. The
existing frontend/prek results below are inherited earlier reports, not rerun in
this backend-only pass. Browser E2E uses a fixture API, not the running Django app.

A bounded localhost Django HTTP + qcluster simulation was rerun using the
pre-existing `/tmp/inventree-http-002jc/http_run.py` runner (not committed and not
modified). It completed **55 expected HTTP assertions**, with zero failed status
assertions. Cabinet/drawer/bin/layout and electrical topology save/reload, ETag
missing/stale checks, preview/publish, duplicate/bounds/shrink rejection with
unchanged layout and ETag, profile create/edit and duration cap, drawer/bin locate,
single/range pixel simulation, worker execution and session stop were exercised.
Four simulated sessions reached active and stopped, using RGB `[3, 17, 29]`,
brightness 12 and 3-second duration. Evidence is in `/tmp/inventree-http-002jc/`:
`http-evidence.json`, `http-run.log`, `runserver.log`, `qcluster.log`,
`migrate-plugin.log` and `final-db-evidence.log`. A separate bounded real HTTP GET
of the persisted layout returned diagnostics `valid: true`, no errors/warnings,
ETag `"5"`, and the expected unused range `[61, 120]`; request/response evidence
is in `/tmp/inventree-http-002jc/diagnostics-http.json`. The separate distinct-drawer
conflict was covered through the real Django REST API test client, which confirmed
HTTP 400 `allocation_overlap` and no mapping/allocation mutation; it was not added
to the external HTTP runner because that would require editing its harness. This is
localhost simulated HTTP/worker evidence only—not browser-against-Django, device
HTTP, physical light output, or hardware commissioning.

The electrical model represents a controller with one or more `ControllerOutput`
rows and each output with one or more child `LEDString` rows. Each string carries
its own output-relative offset and pixel count; mappings reference string IDs and
string offsets, so two separately addressable strings are representable when the
actual WLED outputs are known. The software model does not establish which owner-
labelled physical string is attached to a particular WLED bus/output or its order.

**Hardware status remains NO-GO for pixel writes and physical acceptance.** A
prior read-only discovery recorded in `docs/hardware/WLED_CONTROLLERS.md` verified
HTTP reachability, WLED 16.0.1, totals (1,161 and 1,196), full-length enabled
segments at master brightness 128, and sanitized `hw.led.ins` bus ranges:
controller 1 `[0,546)` and `[546,1161)`; controller 2 `[0,528)` and `[528,1196)`.
These configuration ranges align with the owner-reported counts. The owner's
string labels, physical bus/output assignment, pixel order, wiring and optical
illumination are **not** verified. No raw `/json/cfg` response or secrets are
retained in the report.

**Adapter safety assessment (2026-10-18): NO WRITE.** `WledAdapter.apply()`
reads/validates the controller, then writes master-off, takes over/replaces the
canonical segment, arms WLED nightlight backup, switches master-on at the requested
brightness, clears the canonical segment and writes pixel chunks. Its exception
path invokes `clear()` only after the adapter marks output live. `clear()` issues
master-off, canonical-segment clear, and nightlight-disable, and verifies an
off/black/unfrozen state. It does not snapshot or restore the previous segment,
master brightness/on state, nightlight configuration, or visible pixels. Therefore
its stop/cleanup path cannot restore the observed original visible state and can
leave the former state changed. The API's logical pixel-test path also requires a
published mapping; choosing a mapping based on matching counts would wrongly
assume owner string labels correspond to bus entries. These are concrete blockers
to the requested API/worker test: a one-pixel effect would not be state-preserving,
and physical assignment is unobserved. No controller write request was made; no
pixel-test session ID, write payload or write response exists; no restoration was
attempted or needed. No human optical observation was available. Do not write via
this adapter until the owner establishes the physical mapping and a reviewed,
reliable visible-state snapshot/restore procedure is available.

When cleared by the owner, the physical procedure is: use the documented
configuration-based ranges only after confirming the exact physical mapping;
create disposable app controller/output/string definitions matching each verified
bus range; capture the current visible state; run one pixel at each bus start
through the app API and worker at brightness <=8 for <=2 seconds; immediately
stop, restore the captured visible state in a `finally` path and read it back.
Never save presets or modify bus/segment/network/firmware configuration. Stop on
any ambiguous response, restoration mismatch or unexpected output. Obtain human
observation separately for each bus before making any string/cabinet mapping claim.
Until that procedure is safe, the exact blocker above prevails and no write is
permitted.

### Current backend verification and commands (2026-10-18)

All Django commands below were run from `src/backend/InvenTree` with the specified
recovered venv and disposable SQLite DB. The first `makemigrations` attempt omitted
`INVENTREE_SITE_URL` and exited 255 with the expected configuration error
(`No CSRF_TRUSTED_ORIGINS specified`); rerunning with the URL succeeded.

```sh
PYTHONDONTWRITEBYTECODE=1 INVENTREE_DB_ENGINE=sqlite INVENTREE_DB_NAME=/tmp/inventree-http-002jc/db.sqlite3 INVENTREE_STATIC_ROOT=/tmp/inventree-http-002jc/static INVENTREE_MEDIA_ROOT=/tmp/inventree-http-002jc/media INVENTREE_BACKUP_DIR=/tmp/inventree-http-002jc/backup INVENTREE_PLUGINS_ENABLED=true INVENTREE_PLUGIN_TESTING_SETUP=true /home/spetchal/.local/share/my-inventree-002jc/venv/bin/python -B manage.py test storage_layout.tests --keepdb --exclude-tag migration_test --settings=storage_layout.test_settings
# PASS: 520 tests

PYTHONDONTWRITEBYTECODE=1 INVENTREE_DB_ENGINE=sqlite INVENTREE_DB_NAME=/tmp/inventree-http-002jc/db.sqlite3 INVENTREE_STATIC_ROOT=/tmp/inventree-http-002jc/static INVENTREE_MEDIA_ROOT=/tmp/inventree-http-002jc/media INVENTREE_BACKUP_DIR=/tmp/inventree-http-002jc/backup INVENTREE_PLUGINS_ENABLED=true INVENTREE_PLUGIN_TESTING_SETUP=true /home/spetchal/.local/share/my-inventree-002jc/venv/bin/python -B manage.py test storage_layout.tests.test_migrations --tag migration_test --settings=storage_layout.test_settings
# PASS: 6 tests, fresh test database

PYTHONDONTWRITEBYTECODE=1 INVENTREE_SITE_URL=http://localhost INVENTREE_DB_ENGINE=sqlite INVENTREE_DB_NAME=/tmp/inventree-http-002jc/db.sqlite3 INVENTREE_STATIC_ROOT=/tmp/inventree-http-002jc/static INVENTREE_MEDIA_ROOT=/tmp/inventree-http-002jc/media INVENTREE_BACKUP_DIR=/tmp/inventree-http-002jc/backup INVENTREE_PLUGINS_ENABLED=true INVENTREE_PLUGIN_TESTING_SETUP=true /home/spetchal/.local/share/my-inventree-002jc/venv/bin/python -B manage.py makemigrations --check --dry-run --settings=storage_layout.test_settings
# PASS: No changes detected
```

The distinct-drawer overlap regression is
`MappingApiTests.test_publish_rejects_overlap_with_distinct_drawer_over_http`.
It passed in the 520-test plugin suite. It was additionally exercised through an
external HTTP client against bounded Django `runserver 127.0.0.1:8137 --noreload`
using `/tmp/inventree-http-002jc/db.sqlite3`; the supervisor script was a temporary
file at `/tmp/inventree-http-002jc/distinct_overlap_http.py` (no repository harness
was added or changed). Exact invocation:

```sh
python /tmp/inventree-http-002jc/distinct_overlap_http.py
# PASS: 201 initial mapping publication; subsequent POST returned HTTP 400 allocation_overlap
# GET layout before/after: ETag "7" both times; layout and allocation snapshots unchanged
```

The candidate used an existing electrical string, total 120, and two distinct
drawers with adjacent allocations 1–60 and 61–120. The rejected replacement
changed only the first drawer to 1–70, leaving the other drawer's allocation
retained, creating an overlap. The response was HTTP 400 `allocation_overlap`;
the complete serialized layout, both allocation records, and ETag were unchanged.
Sanitized evidence (request/response summaries, payload summary, allocation ranges,
and assertions; no credentials or raw configuration) is
`/tmp/inventree-http-002jc/distinct-overlap-http.json`. The process supervisor
terminated the server in `finally`; a follow-up process check found no matching
server/worker on port 8137. The worker/session acceptance evidence remains
simulation-only and is not hardware acceptance. An additional subsequent rerun
against this already-mutated disposable DB was unsuccessful due to pre-existing
layout geometry/allocation state; that failed rerun does not supersede the recorded
successful HTTP run or its evidence.

The prior 0.16.0 failure below is superseded by the pinned-tool verification:
/home/spetchal/.cache/prek/hooks/python-rMn3iuNP9hegOeW2LmQ2/bin/ruff
0.15.12. From the repository root, both commands passed on all three changed
backend Python files (`services.py`, `tests/test_api.py`, `tests/test_services.py`):

```sh
/home/spetchal/.cache/prek/hooks/python-rMn3iuNP9hegOeW2LmQ2/bin/ruff check --preview src/plugins/storage_layout/storage_layout/services.py src/plugins/storage_layout/storage_layout/tests/test_api.py src/plugins/storage_layout/storage_layout/tests/test_services.py
# PASS
/home/spetchal/.cache/prek/hooks/python-rMn3iuNP9hegOeW2LmQ2/bin/ruff format --check --preview src/plugins/storage_layout/storage_layout/services.py src/plugins/storage_layout/storage_layout/tests/test_api.py src/plugins/storage_layout/storage_layout/tests/test_services.py
# PASS
```

No unrelated control-flow refactor or lint suppression was introduced. Historical
0.16.0 output is intentionally omitted here; it was a tool-version mismatch, not a
current blocker. `git diff --check` passed previously; no commit or push was made.
