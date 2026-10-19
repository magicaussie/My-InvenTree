# My-InvenTree deployment status — checkpoint 002J-L

**Status: SSH verified; Development access/runtime installation package prepared; exact privileged execution approval pending.** No remote writes or deployments have been made. Development/Main remain planned installations: no deployed URLs, image digests, application storage, backups, plugin state, or browser save/reload results are verified.

## Verified connection and inventory — 2026-10-19

The owner confirmed console hostname `mainserver`, Tailscale IP `100.98.254.48`, and Ed25519 fingerprint `SHA256:H+aUvO7OlOktdTKU9EpVWjtC4uEBMLAWqwNAVAiJ2RI`. A newly scanned public host key matched this fingerprint before it was pinned in the workstation's `~/.ssh/known_hosts` for `mainserver-1` and its IP. The obsolete `mainserver` DNS endpoint was not changed.

Verified key-only command (existing workstation credentials; no password requested):

```sh
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=8 spetchal@mainserver-1 'hostname; id'
```

Returned hostname `mainserver`, uid/gid 1000 `spetchal`. This existing account has `sudo`, `docker`, and `lxd` group membership. No membership was added. This is **not** the desired constrained deployment identity; use it only for approved read-only diagnostics until a dedicated mechanism is reviewed. Docker inventory used existing socket access for read-only commands only.

- Ubuntu 26.04 LTS; Docker client/server 29.5.2; Compose v5.1.4.
- 32 CPUs; approximately 60 GiB RAM, 35 GiB available; 8 GiB swap.
- `/`, `/DATA`, and `/srv` share the root ext4 filesystem: 1.9 TiB total, approximately 1011 GiB available. These paths are not independent disks.
- Docker data root `/var/lib/docker`; `/DATA/AppData` exists and is world-writable, so it must not hold trusted deployment policy/wrappers.
- Inventory observed 66 containers, 54 running. No container name matched `inventree`. Existing containers/networks/volumes were listed without reading environment secrets or altering resources.
- Port 8081 belongs to `router-qwen3-1.7b`; port 8082 belongs to `searxng`. Neither may be reused. TCP ports 18081 and 18082 had no listeners at inspection; recheck before any deployment.
- Existing unrelated unhealthy/restarting services were observed and left untouched.

### Proposed access/privilege plan — approval required

- Host: confirmed `mainserver-1` / `100.98.254.48`.
- New identity: proposed `inventree-deploy`, dedicated Ed25519 key, restricted authorized-key options, no Docker/LXD group, no unrestricted sudo.
- Proposed Development project: `myinventree-dev`, trusted policy under `/srv/myinventree/dev`, application endpoint on port 18081; bind address and exact storage ownership require review before installation.
- Permit only fixed Development status/deploy/test/backup operations via an owner-reviewed root-owned wrapper (or equivalent controlled CI). No arbitrary shell, Compose arguments, mounts, build contexts, or Docker commands. Agent-controlled application containers must not receive host credentials, privileged mode, host networking, or Docker sockets. Final wrapper and configuration must be reviewed before any sudo authorization is installed.
- Main: separately controlled project `myinventree-main`, proposed port 18082. No agent access to Main credentials/storage or deployment actions without specific release approval.
- Initial impact, if approved: create dedicated identity/key authorization and reviewed policy/storage for Development only; later create isolated Dev containers/networks/volumes. Do not modify CasaOS services, firewall, existing containers, Main, or WLED devices.

The owner has approved **preparation** of the account and constrained Development mechanism. The exact implementation is now in `contrib/remote-development/`; approval to execute it is still required. No remote files, privileges, services or keys have been changed.

## Exact installation proposal awaiting owner review

Reviewed files: [package instructions](../contrib/remote-development/README.md), [access installer](../contrib/remote-development/install-access.sh), [runtime installer](../contrib/remote-development/install-runtime.sh), [Compose policy](../contrib/remote-development/compose.yml), [SSH dispatcher](../contrib/remote-development/ssh-dispatcher), [privileged wrapper](../contrib/remote-development/deploy-wrapper), [sudoers](../contrib/remote-development/sudoers.example).

The planned server staging checkout is `/home/spetchal/myinventree-development-review`; the public key is staged at `/home/spetchal/myinventree-access-review/myinventree-development-deploy_ed25519.pub`. Neither directory has been created. After approval, transfer the reviewed committed source there; verify its commit before building. Do not copy the disposable database, queues, `.env` files or private keys. Generate a dedicated workstation Ed25519 key using the package instructions and transfer **only its public key**. If a passphrase is used, unlock it through the workstation SSH agent, never through chat.

These are the exact privileged commands proposed, run in the verified server session **after approval and source staging**, not through the deployment identity:

```sh
# Verify the reviewed commit matches the approved package before running these.
cd /home/spetchal/myinventree-development-review
sudo -n docker build --pull=false -f contrib/storage-layout-integration/Dockerfile --target backend -t localhost/myinventree-dev-backend:review .
sudo -n docker build --pull=false -f contrib/storage-layout-integration/Dockerfile --target frontend -t localhost/myinventree-dev-frontend:review .
sudo -n docker pull postgres:17-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24
sudo -n docker pull redis:7-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499
sudo -n docker image inspect --format '{{.Id}}' localhost/myinventree-dev-backend:review localhost/myinventree-dev-frontend:review
sudo -n sh contrib/remote-development/install-access.sh /home/spetchal/myinventree-access-review/myinventree-development-deploy_ed25519.pub
sudo -n sh contrib/remote-development/install-runtime.sh
sudo -n visudo -c
id inventree-deploy
sudo -n -l -U inventree-deploy
sudo -n /usr/sbin/sshd -T -C user=inventree-deploy,host=mainserver-1,addr=100.98.254.48
sudo -n /usr/local/sbin/inventree-deploy up
sudo -n /usr/local/sbin/inventree-deploy status
```

`sudo -n` fails rather than prompting for a password. If the administrative session cannot execute these, the owner runs the same reviewed commands in their trusted terminal; do not request their password or expand the deployment account's privileges. Verify effective SSH settings before `up`; a custom `AuthorizedKeysFile`, account allowlist or PAM restriction could require an individually reviewed correction. No SSH daemon configuration/reload is proposed. `--pull=false` preserves pinned build inputs but Docker may fetch missing pinned base images; network downloads are expected.

### Permissions and impact

- Locked-password `inventree-deploy`, home `/var/lib/inventree-deploy`, `/bin/sh` only to permit OpenSSH forced-command dispatch. No interactive shell, PTY, forwarding, agent forwarding, arbitrary exec or Docker arguments are accepted by its authorized key.
- Home and `.ssh`: `root:root 0755`; public `authorized_keys`: `root:root 0644`, with `restrict,command="/usr/local/libexec/myinventree-dev-ssh"`. These public files must be readable by sshd after dropping privileges, but remain unwritable by the account.
- Dispatcher and wrapper: `root:root 0755`; `/etc/sudoers.d/myinventree-deploy`: `root:root 0440`, exact six-command allowance only. Candidate sudoers is validated before installation. No Docker, sudo or LXD group membership.
- `/etc/myinventree-dev`: `root:root 0700`; `compose.yml` and randomly generated `runtime.env`: `root:root 0600`. Installers refuse existing targets instead of overwriting data or policy.
- The only publication is `100.98.254.48:18081` over Tailscale, not all LAN interfaces. Intended URL **not yet deployed**: `http://100.98.254.48:18081`. No firewall/CasaOS changes. DB/backend/Redis have internal-only networking; only nginx joins ingress.
- Project `myinventree-dev`; persistent named volumes `myinventree-dev_postgres`, `myinventree-dev_redis`, `myinventree-dev_app-data`, stored under Docker's `/var/lib/docker/volumes` (confirm actual mountpoints after creation). No volume deletion command is granted.
- Existing production build and plugin bootstrap are reused. Bootstrap creates only fresh representative test locations/accounts, activates the plugin, migrates and collects assets, and forces hardware/dispatcher settings off. No old database or queue is imported. No qcluster/unsafe worker starts. Any essential asynchronous feature requiring a worker remains pending safety review.
- Runtime image policy uses local fixed tags and `pull_policy: never`; record actual image IDs after building. The account cannot build, import or replace images. **Lifecycle automation is provided; unattended source/image updates are not yet provided.** That limitation must not be described as full deployment automation.

After installation, workstation commands use the dedicated key (never print it):

```sh
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -i /home/spetchal/.ssh/myinventree-development-deploy_ed25519 inventree-deploy@mainserver-1 'inventree-deploy status'
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -i /home/spetchal/.ssh/myinventree-development-deploy_ed25519 inventree-deploy@mainserver-1 'inventree-deploy up'
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -i /home/spetchal/.ssh/myinventree-development-deploy_ed25519 inventree-deploy@mainserver-1 'inventree-deploy restart'
```

Ordinary fixed Development lifecycle operations need no repeated approval after installation is approved. Privileged policy/image changes and all Main actions retain their gates. Do not print `runtime.env`, rendered Compose configuration or container environment inspections: they contain credentials. The `logs` operation is bounded but application logs must still be reviewed for accidental sensitive output.

### Verification recorded for this package

- Read-only strict SSH recheck: hostname `mainserver`, existing account `spetchal`; port 18081 still free, deployment account absent, policy path unused. `python3`, `ssh-keygen`, Docker are present.
- Local package policy/dispatcher/installer tests: **12 passed**; both installer syntax checks passed. These are policy tests, not actual account installation or Docker execution tests.
- Application source `src/backend/InvenTree/InvenTree/config.py:get_secret_key` explicitly creates a missing `INVENTREE_SECRET_KEY_FILE` using Django's cryptographic generator; the persistent `/data` key path is supported. Live first boot remains untested.
- No image builds, remote installation, plugin state, authenticated browser Save → refresh persistence, backups or container restart persistence have been verified. Do not report this checkpoint complete.

### Main preparation boundary

Main remains undeployed and has no credentials or agent-accessible policy. Reserve a separate future project `myinventree-main`, Tailscale port 18082 (recheck), independent PostgreSQL/Redis/app-data volumes and independently generated secrets. Never reuse Development credentials, test accounts, seed or data. Main requires an owner-approved immutable release/digest and separately reviewed bootstrap, backups and deployment commands. The Development wrapper cannot target Main. An executable Main configuration and tested backup/restore procedure are still pending; this is an explicit limitation, not a completed deployment.

## Earlier workstation and repository observations (historical)

- Checkout: `/media/spetchal/New Volume1/My-InvenTree-development-002JD/`
- Branch: `development/my-inventree`
- The implementation checkpoint `130a76913d2059099c6da908c0c88b519a418a4c` exists and remains the inspected `origin/development/my-inventree`. On the 2026-10-19 recheck, local `HEAD` was `eb3b1d313` (SSH prerequisite documentation), one commit ahead of origin. Untracked `ZED_ACTIVE_TASK.md` and `dev_browser_settings.py` were left untouched.
- The workstation SSH config contains entries `Ai-Ubuntu` (`192.168.1.204`) and `Home_Assistant` (`192.168.1.103`), both with user `spetchal`; it contains no `mainserver` entry. These entries do not establish mainserver access.
- `getent` resolves `mainserver` to `100.105.131.56 mainserver.taila2e6fe.ts.net`.
- The attempted read-only SSH probe, `ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=8 mainserver 'hostname; id'`, timed out connecting to port 22 before authentication. No server account, host fingerprint, SSH service status, Docker/CasaOS resources, ports, storage, or deployment was verified.

### Reachability recheck: 2026-10-19

- The original `mainserver` endpoint still times out on SSH port 22. Tailscale reports it offline, last seen 101 days ago.
- Tailscale also lists `mainserver-1` at `100.98.254.48`; DNS resolves it to `mainserver-1.taila2e6fe.ts.net`.
- A strict, batch-mode SSH probe to `mainserver-1` reached host-key verification and stopped with `No ED25519 host key is known`. No host key was accepted, authentication completed, or remote command executed. This establishes an SSH endpoint is reachable, **not** that it is the intended CasaOS server.
- Owner confirmation of this node and its Ed25519 fingerprint is now the next prerequisite. No SSH configuration, account, key authorization, or server configuration was changed.

## Owner: read-only server diagnostics

Run these locally on the Ubuntu mainserver (console or an already trusted administrative session). They inspect state only; do not change configuration or enable services as part of this checkpoint:

```sh
hostname
hostnamectl --static
ip -brief address
systemctl status ssh --no-pager
ss -ltn
if command -v tailscale >/dev/null 2>&1; then tailscale status; else echo 'tailscale not installed'; fi
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

Confirm whether this machine is the intended Ubuntu CasaOS host and whether its Tailscale address is `100.98.254.48` (`mainserver-1`). These commands identify the host, show network addresses, inspect the SSH listener, and print only the public host-key fingerprint; they do not authorize deployment or reveal private keys. Do not run account/key authorization commands until the endpoint is confirmed and an exact dedicated-account plan is reviewed.

Share the output needed to diagnose reachability and the host key through a trusted channel; review it for sensitive information first. The server host-key fingerprint must be compared and explicitly confirmed by the owner before it is trusted. Do not disable `StrictHostKeyChecking` or accept an unknown key just to proceed. A port-22 timeout alone does not show whether the cause is routing, firewall, SSH service state, or another condition.

## Access plan — proposed, not authorized or installed

Once connectivity is diagnosable and the owner explicitly approves access:

1. Agree the precise host identity, account name, reachable SSH endpoint, and host fingerprint with the owner. Do not infer an account or privilege level from the workstation's unrelated SSH entries.
2. Generate a dedicated Ed25519 key pair on the workstation, using a protected private key and passphrase where practical. Keep the private key local; never paste, print, commit, or log it. Have the owner authorize its public key for a dedicated non-root account through their trusted server-side process. No key or account has been created as part of this checkpoint.
3. Verify key-only access and the confirmed host key with strict checking, then test only the approved read-only commands. Do not grant Docker group/socket access or unrestricted sudo.
4. Before any remote write, present an exact owner-reviewed privilege and impact plan. Use a constrained mechanism that prevents the agent from changing deployment configuration, build contexts, mounts, or commands beyond its approved scope. A root-owned Compose file by itself is not sufficient isolation if those inputs remain agent-editable.
5. Scope any eventual Development capability to Development only. Keep Main independently gated and read-only to agents unless the owner explicitly approves a particular promotion, database operation, or credential access. Main deployment always requires individual owner approval.

No privileged changes or deployment have been approved or performed. Do not disturb existing CasaOS services/containers. Never log or expose secrets. Do not import the old disposable SQLite database or original Django-Q queue, or start its workers. Physical WLED writes (including controller POST/PUT, test, locate, or clear operations) are not authorized.

## Work required after the blocker is cleared

Continue from checkpoint `002J-L` and perform the required read-only inventory before proposing any write: inspect existing containers/services, free ports, storage/capacity, networking and supported InvenTree deployment approach without disturbing existing resources. Confirm a scoped access plan and obtain specific approval before creating or changing anything. Preserve each environment's independent database, cache, media/static data, secrets, and queues. Keep hardware writes disabled by default. Never promote Development data to Main or import the old database/queue.

Only report a deployment as complete after checking the actual server and recording verified URLs, immutable source/image identity, project names and storage locations, service/health status, plugin/frontend/API behavior, authenticated save-and-reload persistence, backups, and safety checks. Record tests actually run and distinguish verified observations from proposed design and pending owner actions. No tests or deployment checks were run for this documentation-only checkpoint.
