See [CONTRIBUTING.md](CONTRIBUTING.md) for codebase guidance.
Security reports must follow the security policy in [SECURITY.md](docs/docs/SECURITY.md) and provide how they interact with the [threat model](docs/docs/concepts/threat_model.md).

Do not open a pull request without manual review by a human. Do not file AI generated issues under any circumstances.
Using AI generated content in issue/PR discussions might lead to code of conduct violations and/or bans.

## My-InvenTree AI development workflow

For Zed and other coding agents working on this fork, follow [docs/ai/DEVELOPMENT_WORKFLOW.md](docs/ai/DEVELOPMENT_WORKFLOW.md) for bounded implementation, focused testing, safe development-branch pushes, and concise GitHub review handoffs. These additional rules do not override the contributor, security, or human-review requirements above.

## Storage Layout documentation maintenance

For every Storage Layout plugin change, review [the graphical user guide](docs/storage-layout/README.md) in the same change. Update affected instructions, diagrams and screenshots whenever UI labels, dimensions, cabinet/drawer/bin workflows, saving, validation, topology, mapping or safety behaviour changes. For changes with no user-facing effect, explicitly record that the guide was reviewed and why no update is needed. Keep screenshots credential-free; use only approved Development browsing, never hardware actions or Main, and do not modify shared cabinet data just to obtain illustrations. Distinguish browser-verified behaviour from source-checked or illustrative instructions.

## Deployment checkpoint 002J-L: Development operational; Main forbidden

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

## Deployment checkpoint 002J-M — deployed designer repair (supersedes pending notes below)

- Deployed application source is `2bb7375ed` (includes identity fix `4616314ea`). Verified Development browser regression completed successfully, including refresh and container restart, using isolated cabinet `53ac7a4f-a093-480e-830c-143dc7aa2ddf`.
- Backend image `sha256:a99974b2f6c86fc2f0db609e85c5128bd4d06805b705e0e0a8de87640951de54`; frontend image `sha256:0796bd4cd2a1612a7419ca1e0aac7784b14bf0ceb8bdfb1bd95f610a8c5e5c9c`. Both running containers matched these IDs. Fixed Compose matched the reviewed archive byte-for-byte.
- The production build must extract Lingui messages before compilation; otherwise new controls display message IDs. `npm run build` now enforces this.
- Run `SL_CHROMIUM_PATH=/bin/chromium node contrib/remote-development/live-layout-regression.cjs` for authenticated isolated browser acceptance. It creates fixture data and restarts only Development through the dedicated restricted account. Never use against Main. Credentials stay in memory, never logs.
- New drawers (including duplicates/drawn drawers) require distinct structural child native Location IDs; bins require nonstructural children. No automatic native-location creation is provided by the designer. Preserve ownership/binding checks.
- Actual passing checks: Add, Duplicate and Draw with separate saves/refresh; move/resize; adjustable grid/snap; zoom/pan/fit/reset; undo/redo; inspector geometry; bin creation/editing; archive; cabinet dimensions; identical cabinet/drawer/bin geometry and identities after PostgreSQL/container restart. Multi-selection/alignment/distribution were not browser-tested in this run.
- Hardware gates were re-read from the running plugin: both False. No worker, Main, policy expansion or unrelated service change was performed. Rollback tags `localhost/myinventree-dev-{backend,frontend}:rollback-002jm` preserve pre-update images; restoring review tags is admin-only, not allowed through the restricted account.

### Historical pre-deployment record (no longer current)

- The local working tree contains changes for click-and-drag drawer drawing and explicit identification of newly created/duplicated drawers. The guide describes these as source-verified only; they have not been verified in the live Development UI.
- Live Development reproduced the isolated Add+Duplicate save rejection: PUT returned 400 for a new UUID without an explicit new-drawer marker, and a subsequent GET was empty. This is evidence of the failure, not proof the local repair is deployed or live-fixed.
- Local verification reported: backend 79 tests plus one wiring check passed using a `/tmp` harness; frontend 306 tests and typecheck passed. These results do not establish deployment acceptance.
- Origin synchronization reports commit `6669a0fff` synced. Updated application images have **not** been deployed; a narrow admin-only image-build gate remains pending. Main and physical hardware remain untouched. Do not claim task completion.
