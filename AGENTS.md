See [CONTRIBUTING.md](CONTRIBUTING.md) for codebase guidance.
Security reports must follow the security policy in [SECURITY.md](docs/docs/SECURITY.md) and provide how they interact with the [threat model](docs/docs/concepts/threat_model.md).

Do not open a pull request without manual review by a human. Do not file AI generated issues under any circumstances.
Using AI generated content in issue/PR discussions might lead to code of conduct violations and/or bans.

## My-InvenTree AI development workflow

For Zed and other coding agents working on this fork, follow [docs/ai/DEVELOPMENT_WORKFLOW.md](docs/ai/DEVELOPMENT_WORKFLOW.md) for bounded implementation, focused testing, safe development-branch pushes, and concise GitHub review handoffs. These additional rules do not override the contributor, security, or human-review requirements above.

## Storage Layout documentation maintenance

For every Storage Layout plugin change, review [the graphical user guide](docs/storage-layout/README.md) in the same change. Update affected instructions, diagrams and screenshots whenever UI labels, dimensions, cabinet/drawer/bin workflows, saving, validation, topology, mapping or safety behaviour changes. For changes with no user-facing effect, explicitly record that the guide was reviewed and why no update is needed. Keep screenshots credential-free; use only approved Development browsing, never hardware actions or Main, and do not modify shared cabinet data just to obtain illustrations. Distinguish browser-verified behaviour from source-checked or illustrative instructions.

## Viewport workspace correction — current Development

Application `f099aa1d315a20807a88b3c62dc70c8ee4095b5b` is now deployed.
Shared cabinet/drawer canvas fills desktop viewport; initial fit and manual
zoom/pan preservation verified in authenticated Chromium, 22 checks. Frontend
331 tests pass; changed-file lint, typecheck and build pass. Full lint retains an
unrelated commands.test.ts formatting failure. Exact images, archive, rollback,
activation verification and narrow-layout limits: [workspace evidence](docs/storage-layout/evidence/WORKSPACE-F099AA1D3.md).
No fixture writes, Main/hardware/workers/shared records touched. Owner untracked
files remain untouched. Earlier checkpoints below are historical.

## 002J-Q responsive follow-up — Development browser verified with limits

The lead built and deployed application `19d148233b278a4ef6309555eb2cc36b39c72050`.
Actual authenticated Chromium follow-up passed 24 checkpoints, including real
JPEG/WebP uploads, failed-network preservation, cancel/confirm image detach and
restoration on all three isolated backgrounds, pending navigation protection,
425px no-overflow/image/object gestures, 390px override image gestures, and a
restricted restart with exact saved-data/content preservation. See
[final evidence and precise limits](docs/storage-layout/evidence/002J-Q-LIVE-ACCEPTANCE.md).
Read-only exact activation verification passed after restart; all four services
healthy, original backup/rehearsal retained. No Main/hardware/workers/shared
records touched. Fixture records retained; DELETE used only on authorized fixture
background-reference endpoints. Live ownership control remains False: no settings
changes and no live cross-owner claim. Default <425px mobile gate remains; 390px
object gestures remain unresolved, not passed. Current-runtime security resume also
passed invalid-upload/metadata rejection, missing/stale CAS, actual browser stale
conflict, non-admin/anonymous denials and exact saved-data preservation. No
application source changes in acceptance; documentation remains uncommitted.
Preserve all owner untracked files.

## Historical 002J-Q live image acceptance — original baseline, partial acceptance

At this historical checkpoint, application `56271a1ada6d531ac264cf6cfc98b7b6c9aecc8a` was activated in Development.
Read-only inspection confirmed backend `afd216c3e4413aabd63b7c741b23508e8f9ec9a0335234d3c653559fe4b2656f`
and frontend `c56a6405c990a45041bfe26694e0f293aa6f235581059d372bcb13fdfe45be88`.
See [live acceptance and remaining gates](docs/storage-layout/evidence/002J-Q-LIVE-ACCEPTANCE.md).
Desktop real uploads/image and object gestures, separate saves, reload, stale CAS,
permission denials and two restricted restarts passed on one retained isolated
cabinet with two images/bins, quantity-7 stock, non-null active LED mapping and
allocations. Hardware/dispatcher gates remain False; no hardware endpoints used.

Do not claim full acceptance: default host blocks <425 px; deployed drawer panes
produce 852 px horizontal overflow at 425 px. Focused responsive source fix plus
390/425 Chromium regressions pass locally but are NOT deployed. Coordinate lead
before reviewed image rebuild/activation. Live ownership control is False; do not
change shared settings to test cross-owner denial. Actual native ownership tested
only in disposable local Django tests. Never infer it from no-permission 403s.
Original runner retained fixtures without DELETE; follow-up permits only authorized fixture background detach. Preserve owner untracked files.
Guide reviewed and updated with credential-free evidence and verified limits.

## Historical 002J-Q source implementation — before activation

Structure frontend/opening reference UI is retired; backend `Cabinet.structure`
and existing saved data remain. Additive 0005 provides independent Cabinet/Drawer
FileFields and normalized metadata, authenticated PNG streaming and root CAS.
`BackgroundCanvas` now provides private blob underlays and explicit image editing,
upload/replace/remove, fit, placement, opacity, visibility, locks and separate
undo/redo/save. Image saves adopt only the aggregate ETag, never reload layout
drafts. Owner untracked task/scripts/settings/screenshots must remain untouched.
See `docs/ai/002J-Q-DEVELOPMENT-PROPOSAL.md` for exact local test evidence and
release gates. No live Development acceptance, privileged commands, backup/restore,
Main, hardware, workers or live database operations are authorized/performed here.
Review corrections add Navigation API dirty/pending-route protection (legacy
link/unload fallback), editor-scoped image keyboard undo/redo, distinct committed
upload/preview failure status and Lingui controls. Local evidence: 329 frontend,
30 Chromium fixture, 561 backend and 7 migration tests; not live acceptance.
Older checkpoints below are historical, not current source behavior.

## Saved structure reference — source implementation, not deployed

Drawers now offers an explicit saved-structure reference with opening-guided drawing and inward-rounded fitted drawer creation. Cabinet / Structure adds undoable full-height partition/full-width shelf controls. Physical mm geometry is proportionally projected with independent axes; this is not physical calibration and never converts legacy logical dimensions. Bins retain their parent drawer top-down frame. Existing drawers and move/resize remain independent of opening guides. Reference requests and Structure undo history are isolated by cabinet identity. Frontend verification: 327 tests across 18 files and typecheck passed; no live browser acceptance or deployment was performed for these additions. The graphical guide was updated. Require a newly approved exact archive/build before privileged deployment; preserve all existing inventory, mappings and hardware gates.

## Cabinet / Structure feature status — Development deployment and browser verification

The additive nullable `Cabinet.structure` migration and Cabinet / Structure editor were deployed to Development from approved commit `9bb88e3c607931e04645aa8024f600b126d1e733`; archive SHA-256, image IDs, backup evidence and current acceptance evidence are in `docs/DEPLOYMENT.md`. Expanded authenticated isolated-fixture browser acceptance verified exact mm dimensions, partition/shelf draw-move-resize, opening/door/panel, snap, zoom, pan, fit, select, undo/redo, save, refresh, stale-revision rejection and restricted Development restart. A separate populated isolated fixture verified stock/native-location/electrical-topology preservation across structure edits; it had no active LED mapping, so do not claim active mapping preservation. Low-permission writes returned HTTP 403. Screenshots are in `docs/storage-layout/images/live-structure-exercise-*.png`; all fixtures remain isolated and retained for audit.

Never deploy Main, enable workers, operate WLED/hardware, or edit shared cabinet data for screenshots. Keep `ENABLE_HARDWARE=False` and `DISPATCHER_ENABLED=False`. Do not infer active LED-mapping preservation when the fixture's `active_mapping` is null, or authorization behavior from an admin-only run. Reuse only the established private backup verification mechanism in `docs/DEPLOYMENT.md`; no volume deletion or privilege expansion is allowed. Review `docs/storage-layout/README.md`; the product guide was reviewed for this acceptance-only update, with no user-facing feature or instruction changes beyond documenting verified scope and limits.

## Current deployment checkpoint — approved Cabinet / Structure build activated in Development

- Approved commit `9bb88e3c607931e04645aa8024f600b126d1e733`; archive SHA-256 `c0e34a80d65310bf0fc290704be46fda6324bc98d4942b2e66e8d9481ff25e9e`. Exact staged content was hash/byte reconciled to the approved archive. Installed compose matched the archived `contrib/remote-development/compose.yml`; protected deployment details and backup evidence are in `docs/DEPLOYMENT.md`.
- Rollback tags `rollback-002jo` preserved the baseline images `sha256:3e58e7f8f488bdb2f702d8f65776034c0aa7d53b51de8ec5308a336f3a6bf10d` (backend) and `sha256:a758696d416464b6eacb47d54f43b148a0e3f1f9bc22f5186b14912d4aa4b017` (frontend). Running review image IDs are backend `sha256:0a9530a566651f0da7d22da35c0107297316969c5ede22ff76e9b43bd41a978c`, frontend `sha256:1b744d12dc75804dde441a941aafa4ae970e2f815f24305e59a664816774592c`; all four long-running Development services were healthy after the approved restart. Migration `storage_layout.0004_cabinet_structure` is applied.
- Verified persisted plugin gates remain `ENABLE_HARDWARE=False`, `DISPATCHER_ENABLED=False`. No Main, workers, hardware, unrelated services or volume deletion were involved. Extended live acceptance passed on `a62ca76c-a576-48c6-b857-b50fe650669f`; populated-fixture preservation passed on `409dc9f0-c371-4969-97a3-d27d6687e69e` (active mapping absent). Low-permission denial, auth diagnosis, screenshot hashes and remaining limits are in `docs/DEPLOYMENT.md`.
- Preserve owner untracked `ZED_ACTIVE_TASK.md` and `dev_browser_settings.py` as well as any other untracked owner files. Do not stage or commit them.


## Historical deployment checkpoint 002J-L: Development operational; Main forbidden

- Development is verified at `http://192.168.1.108:18081/web/`, project `myinventree-dev` on `mainserver-1`. Main port 18082 is reserved but **Main is undeployed and forbidden** without separate owner approval. Never deploy/promote to Main, modify its DB, or copy Dev data into it.
- Use strict batch SSH and the dedicated workstation key `/home/spetchal/.ssh/myinventree-development-deploy_ed25519` as `inventree-deploy@mainserver-1`. Never read/print/transfer the private key. The only accepted commands are `inventree-deploy {up|stop|start|restart|status|logs}`. Ordinary approved fixed Dev lifecycle needs no repeated approval; policy/image changes remain administrator-reviewed.
- Account-wide sshd Match/ForceCommand plus key forced-command are installed. Account has a locked password, key-only auth, no forwarding/PTY/user rc and no docker/sudo/lxd groups. Sudo permits only the six exact wrapper commands. Never expand these privileges or expose the Docker socket. `spetchal` administrative SSH is only for specifically approved installation/diagnostics, not unrestricted agent deployment.
- Trusted policy/secrets are root-owned under `/etc/myinventree-dev` (0700; files 0600). Never print runtime.env, rendered Compose, container environment, tokens or persistent keys. No host binds/devices/socket/privileged containers are allowed.
- Application build source `c3bf19c72a16bfc2f172ed1a35c17c0f0ac157f3`; installed restart wrapper source `a3ef232c1`. Exact image digests, archive hashes, paths, verification commands and limitations are in `docs/DEPLOYMENT.md`. Do not assume the latest documentation commit was rebuilt into application images.
- Four long-running services are healthy; bootstrap exited 0. Real authenticated browser designer PUT returned HTTP 200 and dimensions `640x840`, revision 6 survived refresh, service restart and backend/proxy replacement. Routine `restart` deliberately excludes bootstrap; `up` can rerun seed and invalidate sessions. Never delete volumes as an update strategy.
- Named volumes `myinventree-dev_postgres`, `myinventree-dev_redis`, `myinventree-dev_app-data` preserve fresh PostgreSQL/cache/media/static/keys. No old SQLite or original Django-Q queue was imported. Never import them or start old/unreviewed workers. No qcluster is configured; asynchronous features remain limited pending safety review.
- Plugin storage-layout is active with ENABLE_HARDWARE=False and DISPATCHER_ENABLED=False. No physical WLED operations (including locate/test/clear), watchdog or dispatcher writes are authorized. Keep these gates off.
- All 66 unrelated CasaOS container IDs/names were preserved. Do not restart Docker/host or modify CasaOS/firewall to test durability; host reboot was not tested. Main and hardware writes always need independent owner approval.
- Private backups live under `/var/backups/myinventree-dev`; a PostgreSQL dump restored successfully into an isolated scratch DB. Do not expose backup contents or restore over live data without explicit approval. See docs for tested versus pending media/off-host recovery.
- Preserve owner untracked `ZED_ACTIVE_TASK.md` and `dev_browser_settings.py`. HTTP endpoint is trusted-LAN-only, not TLS-protected. Do not claim dual-environment completion while Main remains forbidden.

## Historical deployment checkpoint 002J-M — prior deployed designer build

- Deployed application source is `2bb7375ed` (includes identity fix `4616314ea`). Verified Development browser regression completed successfully, including refresh and container restart, using isolated cabinet `53ac7a4f-a093-480e-830c-143dc7aa2ddf`.
- Backend image `sha256:a99974b2f6c86fc2f0db609e85c5128bd4d06805b705e0e0a8de87640951de54`; frontend image `sha256:0796bd4cd2a1612a7419ca1e0aac7784b14bf0ceb8bdfb1bd95f610a8c5e5c9c`. Both running containers matched these IDs. Fixed Compose matched the reviewed archive byte-for-byte.
- The production build must extract Lingui messages before compilation; otherwise new controls display message IDs. `npm run build` now enforces this.
- Run `SL_CHROMIUM_PATH=/bin/chromium node contrib/remote-development/live-layout-regression.cjs` for authenticated isolated browser acceptance. It creates fixture data and restarts only Development through the dedicated restricted account. Never use against Main. Credentials stay in memory, never logs.
- At checkpoint 002J-M, new drawers/bins required native child Location IDs; this is superseded for current source behavior by checkpoint 002J-N in `docs/DEPLOYMENT.md`. Do not infer that source-tested changes are deployed.
- Actual passing checks: Add, Duplicate and Draw with separate saves/refresh; move/resize; adjustable grid/snap; zoom/pan/fit/reset; undo/redo; inspector geometry; bin creation/editing; archive; cabinet dimensions; identical cabinet/drawer/bin geometry and identities after PostgreSQL/container restart. Multi-selection/alignment/distribution were not browser-tested in this run.
- Hardware gates were re-read from the running plugin: both False. No worker, Main, policy expansion or unrelated service change was performed. Rollback tags `localhost/myinventree-dev-{backend,frontend}:rollback-002jm` preserve pre-update images; restoring review tags is admin-only, not allowed through the restricted account.

### Historical pre-deployment record (no longer current)

- The local working tree contains changes for click-and-drag drawer drawing and explicit identification of newly created/duplicated drawers. The guide describes these as source-verified only; they have not been verified in the live Development UI.
- Live Development reproduced the isolated Add+Duplicate save rejection: PUT returned 400 for a new UUID without an explicit new-drawer marker, and a subsequent GET was empty. This is evidence of the failure, not proof the local repair is deployed or live-fixed.
- Local verification reported: backend 79 tests plus one wiring check passed using a `/tmp` harness; frontend 306 tests and typecheck passed. These results do not establish deployment acceptance.
- Origin synchronization reports commit `6669a0fff` synced. Updated application images have **not** been deployed; a narrow admin-only image-build gate remains pending. Main and physical hardware remain untouched. Do not claim task completion.
