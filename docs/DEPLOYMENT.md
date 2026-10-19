# My-InvenTree deployment status — checkpoint 002J-L

**Status: blocked before server inspection.** No deployment or server-side changes were made. The planned Development/Main Compose environments are requirements, not existing or verified installations. There are no verified deployment URLs, Compose project names, storage paths, container states, ports, backups, plugin state, or browser results.

## Verified workstation and repository facts

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

No privileged changes or deployment are authorized now. Do not disturb existing CasaOS services/containers. Never log or expose secrets. Do not import the old disposable SQLite database or original Django-Q queue, or start its workers. Physical WLED writes (including controller POST/PUT, test, locate, or clear operations) are not authorized.

## Work required after the blocker is cleared

Continue from checkpoint `002J-L` and perform the required read-only inventory before proposing any write: inspect existing containers/services, free ports, storage/capacity, networking and supported InvenTree deployment approach without disturbing existing resources. Confirm a scoped access plan and obtain specific approval before creating or changing anything. Preserve each environment's independent database, cache, media/static data, secrets, and queues. Keep hardware writes disabled by default. Never promote Development data to Main or import the old database/queue.

Only report a deployment as complete after checking the actual server and recording verified URLs, immutable source/image identity, project names and storage locations, service/health status, plugin/frontend/API behavior, authenticated save-and-reload persistence, backups, and safety checks. Record tests actually run and distinguish verified observations from proposed design and pending owner actions. No tests or deployment checks were run for this documentation-only checkpoint.
