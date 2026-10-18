# Project 001: isolated Docker integration

This harness builds **this checkout**, including the complete host frontend and
Storage Layout plugin frontend. It does not use an upstream InvenTree app image.
The stack is disposable development infrastructure, never a deployment recipe.

## Isolation and prerequisites

- An existing, accessible Docker daemon and Compose are required. The harness
  does not install Docker, change services, or use `sudo`.
- `stack.py init` checks Docker and port `18761`, generates a random
  `sl001_<12 hex digits>` project name, and creates private temporary credentials.
- PostgreSQL 17, Redis 7, backend, bootstrap, worker and frontend services use
  only new project-scoped networks and named volumes. Base images are pinned by
  digest. PostgreSQL/Redis/application ports are not published.
- Only nginx publishes **`127.0.0.1:18761`**. The application, worker and database
  join only an **internal** network. The proxy also joins its own fresh ingress
  network: Docker 29 does not publish ports on an internal-only network.
- No Docker socket, existing database, application directory or existing volume
  is mounted. No existing application containers are queried or changed.
- `ENABLE_HARDWARE=false` and `DISPATCHER_ENABLED=false` are explicitly set on the
  plugin. Controller fixtures use unique `.invalid` origins. No physical WLED
  controller is contacted, even for observation.
- Shared Redis caching is explicitly enabled and four worker processes are
  configured. Without this, the core defaults can force one worker and the
  bounded 55-second watchdog can starve interactive simulation tasks.
- Runtime credentials, browser sessions, traces and raw logs remain in the
  gitignored `.runtime/` directory (mode 0700; credential file mode 0600).
  **Never publish that directory.**

## Reproduce

From the repository root:

```sh
python3 contrib/storage-layout-integration/stack.py init
python3 contrib/storage-layout-integration/stack.py build
python3 contrib/storage-layout-integration/stack.py up
python3 contrib/storage-layout-integration/stack.py isolation
python3 contrib/storage-layout-integration/stack.py api
```

The source build uses Python 3.12 (supported by this repository), the locked
backend and development requirements, PostgreSQL's psycopg driver, and the
repository's documented `yarn compile`/`yarn build` host frontend process.
The plugin uses `npm ci` and its catalog/typecheck/Vite build. Bootstrap applies
core migrations, registers and activates the installed plugin, applies plugin
migrations, creates temporary test accounts and collects static/plugin assets.
It is idempotent within this disposable installation.

Browser tests use the plugin's pinned local Playwright dependency. If it is not
already installed, use Node 22+ and install these **local** dependencies/browser:

```sh
npm --prefix src/plugins/storage_layout/frontend ci
node src/plugins/storage_layout/frontend/node_modules/playwright/cli.js install chromium
python3 contrib/storage-layout-integration/stack.py browser
```

The browser opens the actual InvenTree login, navigation, plugin pages and native
stock/location panels. It **does not intercept or mock API requests**. Login is
untraced; session state and diagnostic traces are private runtime artifacts.
Tests create real stock and layout fixtures through the deployed REST API.

Continue with worker, PostgreSQL and persistence checks:

```sh
python3 contrib/storage-layout-integration/stack.py worker
python3 contrib/storage-layout-integration/stack.py backend-tests
python3 contrib/storage-layout-integration/stack.py migrations
python3 contrib/storage-layout-integration/stack.py snapshot
python3 contrib/storage-layout-integration/stack.py restart
python3 contrib/storage-layout-integration/stack.py verify-persistence
python3 contrib/storage-layout-integration/stack.py browser
python3 contrib/storage-layout-integration/stack.py isolation
python3 contrib/storage-layout-integration/stack.py logs
python3 contrib/storage-layout-integration/collect_evidence.py
```

`worker` delivers two additional real Q tasks for one actual simulated session,
asserts they finish without changing its execution acknowledgements or expiry,
and waits for the **scheduled watchdog** (not a direct test call) to expire it
and release the cabinet. It also performs a real plugin registry unload/reload,
checks canonical model/service identity, and compares deployed source hashes to
this checkout. A stable task ID alone is not treated as duplicate-delivery proof.

`backend-tests` uses PostgreSQL's isolated `test_sl001` database, not the stack's
`sl001` development database. `migrations` uses a fresh test database and
`--noinput`; it may replace **only that disposable test database**. Neither command
accesses the machine's pre-existing PostgreSQL installation or port 5432.
`restart` restarts only this project's database, cache, backend, worker and proxy.

The API harness's durable-job hard timeout is 120 seconds; its separate latency
assertion requires an interactive session to activate within 30 seconds. Normal
observed latency with shared cache/four workers was approximately one second.

## Results and evidence

Latest verified integration:

| Check | Result |
|---|---|
| Real HTTP API checks | 80 passed, 0 failed, 0 skipped |
| Real host Chromium browser tests | 7 passed, 0 failed, 0 skipped |
| Plugin/affected-core tests on PostgreSQL | 487 passed |
| PostgreSQL migration lifecycle tests | 6 passed |
| Real duplicate Q deliveries and scheduled expiry | Passed |
| Plugin reload model/service identity | Passed |
| PostgreSQL/cache/app restart and persistence | Passed |
| Loopback publishing, internal app network, project-owned volumes | Passed |

The browser tests cover cabinet drag/numeric edits and bin edits with actual
save/reload, native location and stock-item simulation locate, and worker-driven
observation polling. The API checks cover native bindings, multiple controllers,
1-based/cross-controller/reversed mapping, colours/profiles, permissions,
concurrent CAS, idempotency, drift and fail-closed live requests.

`evidence/verified.json`, `evidence/integration.log` and the two success
screenshots are sanitised, publishable evidence. Raw build, bootstrap, worker,
API and browser logs remain private under `.runtime/`. The evidence collector
rejects output containing the generated passwords and never copies auth state or
traces. The three `test_driver.py` tests are runner **unit** safety regressions,
not substitutes for actual Docker execution.

### Defects found and corrected

- Missing optional Rollup platform entries prevented a clean `npm ci` in Docker;
  regenerated the lockfile without changing selected package versions.
- Duplicate drawer/bin labels and controller origins/MACs returned 500; they now
  return 400 with `duplicate_identity`, including retained/archived identity
  checks. Valid label/display-number swaps are staged atomically.
- Drawer designer confused interior dimensions with front-view cabinet bounds,
  showing a false blocking error; projection/client bounds and regressions fix it.
- AppMixin reload recreated model classes while services kept old classes;
  re-registering retained concrete models preserves identity. Code upgrades to
  app plugins still require process restart.
- Harness bootstrap now explicitly creates PluginConfig/UserProfile rows because
  the host intentionally suppresses some side-effect signals in shell commands.

## Stop / remove only this environment

```sh
# Stop this project, keeping its volumes for another run:
python3 contrib/storage-layout-integration/stack.py down

# Or remove this project's containers, networks and named volumes:
python3 contrib/storage-layout-integration/stack.py destroy
```

Images and Docker build cache are deliberately not pruned. No Docker-wide cleanup
command is provided. The runtime state rejects project names outside the generated
namespace. Saved credentials/evidence are not overwritten by repeated `init`.

## Not tested / not claimed

Physical LEDs, electrical/optical safety, live hardware dispatch/recovery,
Firefox/WebKit, MariaDB, the full unrelated InvenTree core suite, production load
and host power-loss/network-partition qualification are not covered. Simulation
success is not physical hardware success. These tests do not authorize hardware
commissioning, production deployment or any GitHub push.
