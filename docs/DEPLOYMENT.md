# My-InvenTree deployment status — checkpoint 002J-L

**Status: SSH verified; read-only server inventory complete; deployment privilege approval pending.** No remote writes or deployments have been made. Development/Main remain planned installations: no deployed URLs, image digests, application storage, backups, plugin state, or browser save/reload results are verified.

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

No account creation or sudoers commands are provided as ready to execute yet: the wrapper and exact permissions must first be implemented and reviewed. Owner approval is required before privileged installation. The inventory does not authorize deployment.

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
