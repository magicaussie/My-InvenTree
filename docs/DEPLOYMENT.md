# My-InvenTree deployment — status and checkpoints

## Pending source review — saved structure reference controls (not deployed)

The working-tree frontend adds explicit **Load / use saved structure** in Drawers,
proportional mm-to-logical display projection, optional opening-guided drawing and
integer-inward fitted drawer creation, plus undoable partition/shelf span controls
and active-tab keyboard isolation. These changes reuse the existing canvas and
layout save commands; no backend schema, migration, inventory, mapping or hardware
contract changes are introduced. See the updated [graphical guide](storage-layout/README.md#saved-structure--drawer-reference--source-implementation-not-yet-deployed).

Local frontend suite: **327 tests passed across 18 files**, with TypeScript checking passing. Regression tests include cabinet-switch isolation for pending reference requests and Structure undo history.
These are local source tests, not live acceptance of the new controls. No image
build, activation, remote restart, privileged operation or Main/hardware action was
performed for this change. The running image IDs recorded below are the prior
checkpoint, not freshly inspected by this task. A new exact reviewed source/archive
and owner approval remain required before any privileged image build/activation.
This source change is recorded separately from the deployed application. Deployment remains gated on approval of its exact commit/archive and bounded build commands.

For day-to-day cabinet and drawer/bin editing, see the
[Storage Layout graphical user guide](storage-layout/README.md). Screenshots are
credential-free authenticated Development captures; isolated-fixture writes are
identified where used and are not additional commissioning evidence.

## Current deployment checkpoint — approved Cabinet / Structure feature activated in Development

- **Approved source input:** commit `9bb88e3c607931e04645aa8024f600b126d1e733`; archive SHA-256 `c0e34a80d65310bf0fc290704be46fda6324bc98d4942b2e66e8d9481ff25e9e`. Transferred archive `/home/spetchal/myinventree-002jo-9bb88e3c6.tar`; staging `/home/spetchal/myinventree-dev-build-9bb88e3c6` was reused read-only after approval and exact per-file/path content reconciliation. No re-extraction or overwrite occurred. Installed `/etc/myinventree-dev/compose.yml` matched `contrib/remote-development/compose.yml` byte-for-byte (SHA-256 `f2d46709c2e01a6c724852842369867be2fe3e9743dde0f0e6c4c2a0c137f8b2`); policy review confirmed no host binds, privileged mode or hardware access.
- **Rollback and built images:** rollback tags `localhost/myinventree-dev-backend:rollback-002jo` and `localhost/myinventree-dev-frontend:rollback-002jo` retain prior backend `sha256:3e58e7f8f488bdb2f702d8f65776034c0aa7d53b51de8ec5308a336f3a6bf10d` and frontend `sha256:a758696d416464b6eacb47d54f43b148a0e3f1f9bc22f5186b14912d4aa4b017`. The approved backend/frontend targets were built once with `--pull=false`; no subsequent image rebuild was made. Running review IDs after restart: backend `sha256:0a9530a566651f0da7d22da35c0107297316969c5ede22ff76e9b43bd41a978c`; frontend `sha256:1b744d12dc75804dde441a941aafa4ae970e2f815f24305e59a664816774592c`. Backend, proxy, database and Redis were healthy; bootstrap exited 0.
- **Verified backup before activation:** established `sudo -n python3 - < contrib/remote-development/backup-verify.py` completed successfully before `inventree-deploy up`. Backup directory `/var/backups/myinventree-dev/20261020T022240Z`; `postgres.dump` SHA-256 `ac35d1c17889b67f0fb927d1824c176dfda4779fa6c06ee26b126d5e0c1669d7`. No backup contents or secrets are recorded here.
- **Schema and safety:** `storage_layout.0004_cabinet_structure` is applied. Read-only Django plugin query after activation confirmed `ENABLE_HARDWARE=False` and `DISPATCHER_ENABLED=False`. No worker, Main, WLED/controller action, unrelated CasaOS service, volume deletion or privilege expansion occurred.
- **Extended live structure browser acceptance:** the original coordinate and revision-comparison test defects are documented in the earlier run history. The expanded authenticated `--exercise --restart` now passes on isolated cabinet `a62ca76c-a576-48c6-b857-b50fe650669f`: exact envelope `650 × 850 × 450 mm`; exact door position/size `x=330, y=400, width=120, height=250 mm`; partition and shelf draw, move and resize; opening, door and panel draw; snap toggle; zoom, pan, fit, select, undo/redo; save, refresh, HTTP 412 stale-revision rejection without state change, and persistence through restricted Development restart. Legacy logical dimensions/layout remain unchanged. No app defect was observed. Two selector mistakes in the added test (ambiguous `Tool` label and duplicate Undo/Redo controls) were fixed; a later screenshot race was corrected by waiting for the SVG to render. Current screenshot SHA-256: drawn `6ac9236ae22f7a503aaf9cd8a875bbff2431bf70ae617722fcbf03d8723c2152`, saved `999d193177f1f061c022eed52d8e9edae7443d3b1aa41c958cd202a5b8ea416d`, refreshed `6938d188b75993750c98e02607f3d9ba915463a1fc00e69821804ed68d7caa2c`, after restart `6938d188b75993750c98e02607f3d9ba915463a1fc00e69821804ed68d7caa2c`. Fixtures are retained for audit.
- **Populated fixture and authorization acceptance:** corrected disposable-account creation by using the supported superuser `PATCH /api/user/{id}/set-password/` after `POST /api/user/`. The source `UserCreateSerializer` intentionally generates an onboarding password and sets an unusable password, so the earlier `username_password_mismatch` was a test setup error, not an authentication/application defect. Low-permission browser login now succeeds; cabinet-layout mutation and native location creation both return HTTP 403, and revision/location counts stay unchanged. Isolated populated cabinet `409dc9f0-c371-4969-97a3-d27d6687e69e` held quantity 7 at native location `302`; after a Cabinet / Structure edit, stock identity/quantity/location, native Location record, and read-only electrical topology snapshot were unchanged; they also remained unchanged through drawer/bin rename, bin archive and repeated save. The fixture had `active_mapping=null` and empty LED electrical topology; a populated active LED mapping was not available and is **not** claimed as tested. Disposable user ID 14 was deleted; an orphan test user from an earlier failed assertion (ID 12) was positively identified by the generated prefix and deleted.
- **Verification and test-only failures:** local `structure-editor.test.tsx` passed 6/6; both modified scripts pass `node --check`; `git diff --check` passed. During the added populated snapshot check, the first comparator incorrectly treated the expected cabinet revision increment as an electrical topology change; normalization of only that revision fixed the test, and the rerun passed. No application source change or image rebuild was made. The read-only documented `verify-host.py` passed after the browser restart: all 66 unrelated CasaOS container IDs/names unchanged, Development isolation checks passed (four services running, bootstrap exited), and Main absent. Prior focused stale-revision and logical-layout evidence remains unchanged. Browser emitted HTTP COOP-on-LAN and 401 resource console warnings during bootstrap/login, but no page errors; the authenticated acceptance completed successfully.
- **Limits:** the populated preservation fixture had no active mapping and an empty LED electrical topology; stock, native Location and topology snapshot were verified unchanged, but preservation of a populated active LED mapping remains unverified. The disposable non-admin browser login and 403 denials passed after correcting the test's password setup. No app defect or deployed-image rebuild was needed. The earlier broader `designers.spec.ts` run had four unrelated drawer geometry/`Layout` selector failures (11/15 passed); those were not changed or attributed to Cabinet / Structure. Main and hardware remain untouched.

## Historical verified result — transferred archive and live acceptance; build/activation stopped

Development at <http://192.168.1.108:18081/web/> was previously running review-tag images when inspected. User-approved source commit: `10e05fdc21d563c14c9ea10da26f51867bf5229f`; transferred archive SHA-256: `da20e278215d926125f2dffa28452f35ce18fac8091119c05651fb0d2ea53191`.

### Archive, Compose and image evidence

- Read-only reconciliation found extracted content matching the archive; tar comparison differences were ownership metadata only. Installed `/etc/myinventree-dev/compose.yml` matched exactly.
- Staging `/home/spetchal/myinventree-dev-build-10e05fdc2` was already populated and services already ran the new review images. Review-tag and running IDs matched: backend `sha256:3e58e7f8f488bdb2f702d8f65776034c0aa7d53b51de8ec5308a336f3a6bf10d`; frontend `sha256:a758696d416464b6eacb47d54f43b148a0e3f1f9bc22f5186b14912d4aa4b017`. Existing rollback tag `rollback-10e05fdc2` recorded the expected prior IDs (backend `31b46f14…`, frontend `19e1c007…`). The expected old IDs did not match what was running, so build and `up` activation were STOPPED. Images were created Oct 20 00:20 UTC and healthy. This does not establish that this session built them or cryptographically prove build provenance.
- Development remains LAN-only at port `18081`; Main is forbidden. No existing data was touched; acceptance fixtures were retained. Main remained untouched, WLED stayed off, and no workers were changed.

### Live browser acceptance and limits

`live-bin-drawing-acceptance.cjs` passed with real authenticated cabinet/drawer/bin draw, move, resize, undo/redo, save, automatic correct parent, stable IDs across repeated saves and refresh, restricted restart, and collision HTTP 400 with unchanged revision and location count. Fixture cabinet `4664428c-f9f4-4722-a468-43a2c95c9a1f`, drawer `1abcbab9-49e0-4afd-9804-641266ffd654`. Bin drawing is therefore browser-verified on the currently running images, unlike the previous checkpoint's source-only status.

`live-layout-safety-acceptance.cjs` passed on a disposable populated stock record: quantity 7 and location remained unchanged after drawer/bin rename, archive and repeated save; the native location was retained. This is a focused safety check, not general stock-placement acceptance.

Non-admin permissions are UNVERIFIED: normal API user creation returned 201, but login returned 400 `username_password_mismatch`; test users were cleaned up and their removal verified by prefix. Do not claim privileged-actor permission behavior was tested.

## Historical pre-deployment status — superseded by current checkpoint

Before the approved build/activation, the source-only review correctly recorded the
nullable `Cabinet.structure` migration, a read-only live UI, and no deployed feature.
That state is superseded by the current deployment checkpoint at the top of this file.
The migration remains additive and nullable; legacy logical dimensions are not
converted. The live test `contrib/remote-development/live-structure-acceptance.cjs`
now includes an opt-in isolated fixture exercise, stale revision check, refresh and
restricted Development restart. It does not edit shared cabinet records.

The deployment still required an exact approved source/archive, the existing
administrator-approved private backup verification procedure (`backup-verify.py`),
rollback tags and restricted Development activation. Those gates were satisfied for
the exact checkpoint above; they do not authorize Main, hardware actions, workers,
volume deletion or privilege expansion. Preserve named volumes and never expose
backup contents or secrets.

## Historical verified result (2026-10-19; superseded by checkpoint 002J-N)

**Development is operational:** <http://192.168.1.108:18081/web/>. Project `myinventree-dev` on the owner-confirmed CasaOS host `mainserver-1` (hostname `mainserver`, LAN `192.168.1.108`, SSH Tailscale `100.98.254.48`). PostgreSQL, Redis, backend and nginx are healthy; bootstrap exited 0. No manually launched Django/Vite service is required. Docker is enabled at boot and the four long-running services use `restart: unless-stopped`. Host reboot was deliberately **not** performed because it would interrupt unrelated CasaOS workloads.

**Main is forbidden and undeployed.** `http://192.168.1.108:18082` is reserved, not a working installation. No Main containers, credentials or policy were created or accessed. Cross-environment browser/data-isolation testing cannot be claimed when Main is absent. The non-installed `contrib/remote-development/compose.main.yml.example` remains an example requiring separate immutable-release, bootstrap and deployment approval.

The owner explicitly approved privileged build/install/start execution from base `68bc70189`, minimum account-wide SSH tightening and diagnosis of Dev deployment blockers. No additional deployment-account privileges were granted. No old SQLite database or original Django-Q queue was copied/imported. No worker/qcluster, hardware watchdog or dispatcher was started. No WLED writes were performed.

## Source and image evidence

Source staging is an exact `git archive`, not a copy of the workstation working tree. Only the dedicated **public** key was transferred; private keys, untracked `ZED_ACTIVE_TASK.md`, `dev_browser_settings.py`, local databases and `.env` files were excluded.

- Application build source: `c3bf19c72a16bfc2f172ed1a35c17c0f0ac157f3`, descended from approved `68bc70189` with the documented deployment fixes.
- Build archive SHA256: `dc333f2be8b43f9400c0c5811c7b66cd4b252b8d3b239536857a990b7927b772`.
- Installed lifecycle wrapper source: `a3ef232c1` (only wrapper/test changes after the application build).
- Server staging: `/home/spetchal/myinventree-development-review`; archive `/home/spetchal/myinventree-access-review/source.tar`.
- Final staged archive SHA256: `1015280c93f50d024102432044ff6191f2e7a0f943d1cb44ac3fb940d248ec80`. Byte-by-byte comparison of archive files against staging passed. Later documentation/verification-script commits are not represented as rebuilt application code.

| Image | Verified image ID / local repo digest |
| --- | --- |
| `localhost/myinventree-dev-backend:review` | `sha256:380462d9fda1d944232f0641b7832fc4883c87ecf5ec1dd68979f3cfc4903609` |
| `localhost/myinventree-dev-frontend:review` | `sha256:4be7bdb685bbb21f89cd6487cee0fab1d877d024502c806fe90b3ba777c1c2ee` |
| PostgreSQL | `postgres:17-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24` |
| Redis | `redis:7-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499` |

These local application tags are administrator-controlled, not immutable release tags. Runtime uses `pull_policy: never`; the deployment identity cannot build, pull or replace images. The integration Dockerfile pins its base image digests and locks core/frontend requirements, but some supplemental Python/system packages are not fully hash-locked; do not describe this as a bit-for-bit reproducible release build.

The approved build commands ran successfully on the server, with the exact reviewed archive as context:

```sh
sudo -n docker build --pull=false -f contrib/storage-layout-integration/Dockerfile --target backend -t localhost/myinventree-dev-backend:review .
sudo -n docker build --pull=false -f contrib/storage-layout-integration/Dockerfile --target frontend -t localhost/myinventree-dev-frontend:review .
# Pull the exact PostgreSQL and Redis references in contrib/remote-development/compose.yml.
sudo -n sh contrib/remote-development/install-access.sh /home/spetchal/myinventree-access-review/myinventree-development-deploy_ed25519.pub
sudo -n sh contrib/remote-development/install-runtime.sh
```

Installers deliberately refuse existing accounts/policy; **do not rerun them on this installed host**. Future policy/image changes remain separately administrator-reviewed. The fixed Dev wrapper handles ordinary lifecycle, not unattended source/image updates.

## Access boundary: installed and checked

SSH identity remains pinned with strict checking. The owner independently confirmed host Ed25519 fingerprint `SHA256:H+aUvO7OlOktdTKU9EpVWjtC4uEBMLAWqwNAVAiJ2RI`. Use `mainserver-1`; bare `mainserver` resolves to an obsolete endpoint.

```sh
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes spetchal@mainserver-1 'hostname; id'
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes -i /home/spetchal/.ssh/myinventree-development-deploy_ed25519 inventree-deploy@mainserver-1 'inventree-deploy status'
```

The dedicated workstation Ed25519 private key stays in `/home/spetchal/.ssh/myinventree-development-deploy_ed25519`, protected by filesystem permissions; it has no passphrase for batch lifecycle use. Do not read, print, commit or transfer it. Public-key staging is `/home/spetchal/myinventree-access-review/myinventree-development-deploy_ed25519.pub`.

- `inventree-deploy` uid 999, sole group `inventree-deploy` gid 981; **no docker/sudo/lxd groups**. Password status `L` (locked).
- Root-owned home `/var/lib/inventree-deploy` and `.ssh` mode 0755; root-owned public `authorized_keys` mode 0644. Key has `restrict,command="/usr/local/libexec/myinventree-dev-ssh"`.
- Account-wide `/etc/ssh/sshd_config.d/00-myinventree-deploy.conf`: `Match User inventree-deploy`, `ForceCommand` to the same dispatcher, `AuthenticationMethods publickey`, password/keyboard-interactive/GSSAPI/hostbased authentication disabled, one fixed authorized-keys file, no authorized-keys command or trusted user CA, no forwarding/PTY/tunnel/user rc. This is **in addition to** the key restriction.
- `PermitUserEnvironment` is global-only on this OpenSSH version. It is not placed inside `Match`; installer validates its effective value is `no` before reloading. Existing global policy was already `no`.
- `sshd -t`, account-specific `sshd -T -C ...`, `visudo -c` passed. Only `systemctl reload ssh` was used; no daemon restart. Administrative SSH still works afterward. Effective policy was checked from both the Tailscale and workstation-LAN address contexts.
- `/etc/sudoers.d/myinventree-deploy` root-owned 0440 permits exactly `/usr/local/sbin/inventree-deploy {up|stop|start|restart|status|logs}` with no arbitrary args. Wrapper/dispatcher root-owned 0755. No Docker/socket, generic sudo, shell, exec, volume deletion, build or Main command is granted.
- Real dedicated SSH `status`/`up`/`restart` succeeded. Arbitrary `id` and `inventree-deploy status; id` returned `rejected SSH command`; `ssh -W 127.0.0.1:18081` returned `administratively prohibited` (expected exit 255).

Use the dedicated command above with `up`, `stop`, `start`, `restart` or bounded `logs` in place of `status`. Routine approved lifecycle needs no repeated approval. `restart` explicitly excludes bootstrap; `up` may rerun seed/migrations and rehash seeded passwords, invalidating existing sessions. Do not use `up` merely to restart services.

## Runtime, secrets and safety

Trusted policy `/etc/myinventree-dev` is root:root 0700; `compose.yml` and `runtime.env` are root:root 0600. Credentials are generated randomly and were never output. Bootstrap accounts are `sl_admin` and `sl_readonly`; use an owner-approved secure credential retrieval channel, never chat/logs or a committed env file. Browser automation reads only the needed Dev password into process memory, with no trace, screenshot of login, persisted auth state, or printed secret.

Development instance name is persisted as `My-InvenTree DEVELOPMENT` with instance-title enabled. The harmless browser fixture is named `DEVELOPMENT 002J-L persistence`.

Verified runtime controls:

- Only proxy publishes `192.168.1.108:18081:80`. Port 18082 has no listener. No `0.0.0.0` or Tailscale-only web binding.
- PostgreSQL/Redis/backend/bootstrap use the internal private network; only nginx also joins ingress. DB and Redis have no host-published ports.
- All actual container mounts are Dev named volumes, with no host bind mounts, sockets, devices, host networking, privileged mode or added capabilities. All five containers use `no-new-privileges`; backend/bootstrap drop all capabilities. Backend and proxy retain read-only root filesystems and tmpfs scratch storage.
- Built frontend, static/plugin assets and backend API are same-origin via nginx. Actual browser CSRF/authenticated designer PUT succeeded, not merely an API-only test.
- Plugin `storage-layout` is installed/active; persisted plugin settings `ENABLE_HARDWARE=False`, `DISPATCHER_ENABLED=False`. No live-controller records or actions were needed for the browser test. Internal backend networking also prevents ordinary outbound controller access. UI/API tests used a new isolated temporary SQLite test database and mocks, not the old disposable database/queue.
- Four services have health checks and `unless-stopped`; bootstrap is one-shot. Logs are bounded (`local`, 10m × 3); memory limits are installed.

Persistent volume mountpoints verified:

```text
myinventree-dev_postgres  /var/lib/docker/volumes/myinventree-dev_postgres/_data
myinventree-dev_redis     /var/lib/docker/volumes/myinventree-dev_redis/_data
myinventree-dev_app-data  /var/lib/docker/volumes/myinventree-dev_app-data/_data
```

`/data` holds media/static/plugin files and persistent Django/OIDC keys. Never print/read those keys. Never run `down -v`, volume prune, import old SQLite/queue data or promote Dev data into Main.

## Actual acceptance evidence

`contrib/remote-development/browser-smoke.cjs` uses the installed frontend Playwright dependency and an existing Chromium binary. It creates at most one safe Dev cabinet and invokes only real same-origin requests. The final run:

```text
PASS authenticated browser login
PASS plugin discovery/navigation/list
PUT /plugin/storage-layout/api/v1/cabinets/de2fcca3-6946-42e7-9ae3-b80b6c914d0b/layout/ -> HTTP 200
PASS save-refresh persistence: dimensions=640x840 revision=6
PASS container-restart persistence: dimensions=640x840 revision=6
PASS container-replacement persistence: dimensions=640x840 revision=6
```

Exact workstation command (repository root):

```sh
SL_VERIFY_RECREATE=1 SL_CHROMIUM_PATH=/home/spetchal/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell node contrib/remote-development/browser-smoke.cjs
```

Without `SL_VERIFY_RECREATE=1`, the script uses only dedicated lifecycle for restart. The optional replacement proof requires approved administrator SSH for the fixed Dev backend/proxy `up --no-deps --force-recreate --wait`, without deleting volumes or starting workers. No new sudo grant is installed for testing.

Focused validation:

- Deployment-policy unit tests: 15 passed; installer POSIX syntax checks passed.
- Plugin frontend: `npm test -- --reporter=dot`: 303 passed / 16 files; `npm run typecheck` passed.
- Backend plugin UI/validation/API: 164 tests passed. Ran in backend with `INVENTREE_PLUGIN_TESTING_SETUP=true`, new `/tmp/002jl-test.sqlite3`, temporary media/static/backup paths, site URL localhost, `--settings=storage_layout.test_settings --testrunner=django.test.runner.DiscoverRunner --noinput`. No live Dev database tests ran. Initial attempts without plugin test settings and with the default read-only-filesystem-incompatible slow-test report writer failed; corrected invocation passed.
- `verify-host.py`: archive/staging byte comparison, actual container mount/privilege/port inspection, Main absence, and exact set comparison of all **66 unrelated CasaOS container IDs/names** passed. No unrelated container was recreated/stopped by deployment; pre-existing health/restart issues were left alone. Baseline is `/home/spetchal/myinventree-access-review/containers-before.txt`.
- Host `sshd -t`, effective account policy, locked password, group membership and exact sudo allowlist verified; real SSH rejection/forwarding tests passed.

### Defects found and corrected during execution

1. Invalid `PermitUserEnvironment` in `Match` caused sshd validation failure. Candidate policy/key were removed without reload. Only this installer's partial account/files were cleaned before corrected installation; existing SSH/CasaOS files were not removed. Effective global `no` is now required.
2. Backend tried writing OIDC key under read-only `/app/config`: fixed supported `INVENTREE_OIDC_PRIVATE_KEY_FILE=/data/oidc.pem`, retaining read-only root.
3. Proxy health check used loopback Host against strict `SITE_URL`: fixed canonical Host header, retaining site-URL validation.
4. Stale plugin translation catalogs rendered new designer control labels as message IDs: refreshed catalogs and rebuilt images.
5. Routine restart reran bootstrap/password rehash and could invalidate a session: wrapper restart now targets only db/redis/backend/proxy, with regression test.

## Checkpoint 002J-M — prior verified Development update

The previously pending proposal below was approved and executed. **Current deployed application source: `2bb7375ed`**, including `4616314ea`. Development remains **http://192.168.1.108:18081/web/**; Main remains undeployed.

### Executed build and activation

1. Transferred the approved `4616314ea` Git archive using strict batch SCP to `spetchal@mainserver-1`; server SHA-256 matched `f1142bce35bb730976860a0e272d0d7d859e4b81354cbe0edd55a8e42005b125`. Extracted into fresh `/home/spetchal/myinventree-dev-build-4616314ea`.
2. Recorded pre-update images and preserved local rollback tags:
   - Backend: `sha256:380462d9fda1d944232f0641b7832fc4883c87ecf5ec1dd68979f3cfc4903609`, tag `localhost/myinventree-dev-backend:rollback-002jm`.
   - Frontend: `sha256:4be7bdb685bbb21f89cd6487cee0fab1d877d024502c806fe90b3ba777c1c2ee`, tag `localhost/myinventree-dev-frontend:rollback-002jm`.
3. Built both reviewed Docker targets with `sudo -n docker build --pull=false`, then used the unchanged fixed wrapper `sudo -n /usr/local/sbin/inventree-deploy up`. No schema/data migration was introduced. Named data volumes were preserved.
4. Browser testing exposed untranslated new control labels (Draw displayed a Lingui message ID). Corrected the production build to extract source messages before compiling catalogs. Built the correction from Git archive `2bb7375ed`, SHA-256 `95fe2f062dd51236e10377f5d71060aac059c50ae398cd26e1319c3ce0dc8c88`, using fresh directory `/home/spetchal/myinventree-dev-build-2bb7375ed`, the same Dockerfile/targets/tags and fixed activation. No permission or policy change.
5. Installed Compose compared byte-for-byte equal to the reviewed source, SHA-256 `f2d46709c2e01a6c724852842369867be2fe3e9743dde0f0e6c4c2a0c137f8b2`. Policy contains only named data volumes, no host paths, devices, privileged mode or Docker socket. Web binding remains LAN-only `192.168.1.108:18081`; PostgreSQL/Redis have no published host ports.

Final image IDs, verified against both running containers:

| Service | Image ID |
| --- | --- |
| backend | `sha256:a99974b2f6c86fc2f0db609e85c5128bd4d06805b705e0e0a8de87640951de54` |
| proxy/frontend | `sha256:0796bd4cd2a1612a7419ca1e0aac7784b14bf0ceb8bdfb1bd95f610a8c5e5c9c` |

Rollback, if required, is an administrator operation: restore the two preserved rollback image IDs to the fixed `:review` tags, then invoke the existing Development `up` wrapper. Do not delete volumes, downgrade a migrated database without review, or give the deployment account image-tagging privileges. This update required no schema migration.

### Actual acceptance results

Executed from the workstation:

```sh
SL_CHROMIUM_PATH=/bin/chromium node contrib/remote-development/live-layout-regression.cjs
```

This retrieves the existing admin credential into process memory (never logs it), uses real Chromium login and UI events, creates isolated native locations/cabinets, and compares API persistence. Its final successful cabinet was `53ac7a4f-a093-480e-830c-143dc7aa2ddf`.

- Login and plugin designer loaded. Add, Duplicate and click-drag Draw each returned PUT 200 and survived refresh with stable identities.
- Cabinet dimensions changed to `641 × 841`. Draw created `(200,200,100,80)`. Pointer move changed `(0,0)` to `(30,30)` on a 10-unit grid; undo/redo restored/reapplied it. South-east resize changed `60 × 40` to `80 × 60`; inspector edit then saved width `79`.
- Zoom in/out, fit/reset, middle-button pan, grid and snap were exercised with state/geometry assertions.
- Drawer interior opened; a native-bound bin was created and edited to `21 × 20`, saved with PUT 200 and reloaded. Duplicate drawer was archived and retained as an archived record.
- Full cabinet/drawer/bin snapshots before and after the restricted `inventree-deploy restart` were equal, including IDs, locations, geometry and archive state. PostgreSQL, Redis, backend and proxy restarted healthy; bootstrap remained exited 0. Browser reload and API reads succeeded afterward.
- Frontend: `npm run typecheck` passed; 307 tests across 16 files passed. Backend isolated SQLite identity/persistence suite: 22 tests passed. Broader backend run: 83 passed, two plugin-registry wiring setup errors (`get_plugin` returned None under isolated test settings); these are not claimed as passes. Historical 79+1 test results below were not reproduced exactly.
- Running plugin was queried: `ENABLE_HARDWARE=False`, `DISPATCHER_ENABLED=False`. No hardware actions or queue worker were started. No Main deployment or unrelated container commands were performed.

Remaining limitations: numeric native-location binding is still required for new drawers/bins; the UI does not automatically create locations. Multi-select/alignment/distribution were not included in this live acceptance run. Repeated failed test attempts left isolated regression fixtures for audit; existing user cabinet data was not changed. LAN HTTP is not encrypted. Fontconfig emitted cache-directory warnings during the diagnostic management command, without blocking application operation.

### Historical pre-deployment notes (superseded)

## Historical checkpoint 002J-M — original pending record (superseded)

- Origin synchronization reports commit `6669a0fff` synced. This is a local checkpoint; it is not evidence that the current application images contain the changes.
- In isolated live Development testing, Add+Duplicate save failure was reproduced: PUT returned HTTP 400 for a new UUID lacking the explicit new-drawer identity marker, and a subsequent GET returned an empty result. The local changes distinguish newly created drawers from persisted identities; this is not a live repair verification.
- The graphical guide now documents the canvas **Draw drawer** button and click-drag interaction. Both drawing and new-identity behavior are checked against source, not confirmed in the live UI. See [the guide](storage-layout/README.md).
- Local verification reported 79 backend tests plus one wiring check passing with a `/tmp` harness, and 306 frontend tests plus typecheck passing. These checks are not deployment or live acceptance evidence.
- Updated application images have **not** been deployed. A narrow admin-only image-build gate remains pending; do not bypass it or broaden deployment privileges. Main and physical hardware were untouched. This checkpoint is not task completion.

### Pending approval proposal — build Development review images

**Not executed.** This is a narrowly scoped request for administrator approval to build and activate only the Development application images. It does not authorize Main, hardware, policy changes, or broader privilege changes.

The application source is commit `4616314ea`. A Git archive was generated at `/tmp/myinventree-dev-4616314ea.tar` with SHA-256 `f1142bce35bb730976860a0e272d0d7d859e4b81354cbe0edd55a8e42005b125`. After approval, the proposed workstation transfer and server-side verification are:

Workstation transfer:

```sh
scp /tmp/myinventree-dev-4616314ea.tar spetchal@mainserver-1:/home/spetchal/myinventree-dev-4616314ea.tar
```

In the approved server administrator session, verify the archive, create a fresh build directory (intentionally no `-p`), extract it, then work from that directory:

```sh
echo f1142bce35bb730976860a0e272d0d7d859e4b81354cbe0edd55a8e42005b125 /home/spetchal/myinventree-dev-4616314ea.tar | sha256sum -c -
mkdir /home/spetchal/myinventree-dev-build-4616314ea
tar xf /home/spetchal/myinventree-dev-4616314ea.tar -C /home/spetchal/myinventree-dev-build-4616314ea
cd /home/spetchal/myinventree-dev-build-4616314ea
```

Proposed builds from the extracted directory:

```sh
docker build --pull=false -f contrib/storage-layout-integration/Dockerfile --target backend -t localhost/myinventree-dev-backend:review .
docker build --pull=false -f contrib/storage-layout-integration/Dockerfile --target frontend -t localhost/myinventree-dev-frontend:review .
```

`--pull=false` avoids pulling a newer base image, but does **not** pin package inputs: Dockerfile package-manager steps may still access the network. Before activation, inspect the non-secret Compose invariants and confirm that the fixed Development policy still isolates the service on the intended ports and volumes, with hardware disabled. Do not print secrets or container environments. The exact review-image inspection is limited to image tags and IDs:

```sh
docker image inspect localhost/myinventree-dev-backend:review localhost/myinventree-dev-frontend:review --format '{{.RepoTags}} {{.Id}}'
```

Before any schema or data migration, take and verify a private Development backup. **No schema/data migration is required by this proposal.** Only after explicit administrator approval to build and activate these Development images, the proposed fixed lifecycle commands are:

```sh
sudo -n /usr/local/sbin/inventree-deploy up
sudo -n /usr/local/sbin/inventree-deploy status
```

No sudoers or deployment-wrapper changes are proposed. This proposal has not been executed; image construction, activation and live acceptance remain pending.

## Historical checkpoint 002J-N — source-tested update (superseded)

This earlier checkpoint recorded the named native-location picker and atomic native-child creation as source-tested only. It is superseded by the current live browser acceptance above. Do not use its historical deployment IDs or source-only bin-drawing status as current evidence.

### Bounded admin proposal — Development application image rebuild

**Pending supervisor approval; nothing below has been executed.** Request approval only to build and activate the backend and frontend images from the proposed reviewed commit/archive. Supervisor must fill in and approve the exact commit, archive SHA-256, transfer path, fresh extraction directory, target tags, and any build-specific review before execution. Do not reuse the earlier `002JM` archive/hash or infer a commit hash. Capture the proposed commit/hash here after supervisor approval; until then the build input is intentionally unspecified.

Scope is limited to the fixed Development image targets and existing fixed lifecycle wrapper. No sudo grant, sudoers/policy, SSH, wrapper, deployment-account, Compose, or host policy changes are requested. Do not target Main or any hardware, start workers, modify hardware gates, or alter the existing persistent volumes. Do not change the fixed image target names/tags. Create a new, empty archive extraction directory; verify archive SHA-256 before extraction and verify the extracted source corresponds exactly to the approved commit. Before activation, review the fixed Compose file and confirm it is unchanged and uses only the expected named Dev volumes, with no host mounts, devices, privileged mode, added capabilities, socket mounts, or unexpected published ports. Do not print secrets or container environments.

Before replacing image tags, record the currently running backend and frontend image IDs and create/record rollback tags for those exact IDs. Build only the approved backend and frontend targets to the existing fixed `localhost/myinventree-dev-{backend,frontend}:review` tags. Record resulting IDs and build logs without secrets. After explicit approval, activate only through the existing fixed `inventree-deploy up` wrapper and verify status plus focused authenticated Development acceptance. Roll back only through an administrator restoring the recorded prior IDs to the fixed tags and invoking the same wrapper. Preserve every named volume; never use `down -v`, volume pruning, or data imports. This proposal authorizes no execution until the supervisor supplies and approves the missing commit/archive identity and scope.

## Backups, restore and recovery

Administrator-only `backup-verify.py` creates `/var/backups/myinventree-dev/<UTC timestamp>/` mode 0700, writes PostgreSQL custom-format dump, complete app-data tar, and private runtime/policy copies with restrictive umask. These contain secrets and must stay private. It restores the dump into **only** scratch DB `dev_002jl_restore_verify`, verifies the persisted cabinet, drops that scratch DB, and fully reads the app tar without extracting or printing secrets. This grants no deployment-identity backup/exec privileges.

Verified initial backup `/var/backups/myinventree-dev/20261019T121755Z` restored cabinet `660|860|3`; final backup `/var/backups/myinventree-dev/20261019T122606Z` restored `640|840|6`. The app archive contained readable media/static data and both persistent key files. PostgreSQL restore was actually exercised; an end-to-end media restore into a replacement stack and off-host retention are not yet exercised. For application-consistent future backups, pause Dev writes during the DB/app snapshots; the test had no concurrent user writes.

Approved administrator verification commands from the workstation repository root:

```sh
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes spetchal@mainserver-1 'sudo -n python3 -' < contrib/remote-development/verify-host.py
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes spetchal@mainserver-1 'sudo -n python3 -' < contrib/remote-development/backup-verify.py
```

Recovery: use dedicated `status` then `restart` for transient Dev failures. Do not delete volumes. Before an approved image update, take a private backup and record current image IDs; administrator installs reviewed images/policy then uses fixed `up`. Schema rollback is not guaranteed by an older image: validate the backup in a separate isolated Dev restore target first, then obtain specific approval before replacing live data. Never restore over Main or automatically promote Dev.

## Remaining limits, not false completion claims

- Main remains intentionally forbidden; dual-stack acceptance and cross-stack isolation tests await separate Main authorization.
- No unsafe queue worker runs; asynchronous features report the worker unavailable. Email is not configured. Do not enable a worker merely to clear health warnings.
- HTTP is LAN-only but **not encrypted**. Use only the trusted LAN; no public ingress/firewall/TLS changes were authorized. Do not reuse important external credentials.
- Application emits read-only font-cache/Gunicorn-control-directory warnings and default report-template initialization warnings; login/designer persistence and service health passed despite these. Full reporting/background-task acceptance was not performed.
- Restart/replacement durability is proven; host reboot is not. No automatic image/source updater, scheduled/off-host backup, or tested full disaster-recovery stack is claimed.
- Local untracked owner files remain untouched. No push or pull request was requested or performed.
