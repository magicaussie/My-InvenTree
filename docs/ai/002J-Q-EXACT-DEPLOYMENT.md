# 002J-Q exact Development deployment approval request

Status: **NOT EXECUTED — owner approval required**. Application input is only
`56271a1ada6d531ac264cf6cfc98b7b6c9aecc8a`, never branch HEAD.

## Previously recorded read-only inspection, 2026-10-20

Historical evidence below was not revalidated during this tooling correction.
No live access was used; current host state and available disk space are unknown.

- Archive `/tmp/myinventree-002jq-image-review-56271a1ad.tar` verified SHA-256
  `0bee583df53713b8a6c92506ec41bfb3ffd385646977c0d5493f6ff87916c4ad`.
- Backend baseline `sha256:0a9530a566651f0da7d22da35c0107297316969c5ede22ff76e9b43bd41a978c`.
- Frontend baseline `sha256:1b744d12dc75804dde441a941aafa4ae970e2f815f24305e59a664816774592c`.
- Four long-running containers healthy; bootstrap exited zero. Redis service is
  `myinventree-dev-redis-1`, not `cache`.
- Installed Compose matches pinned source SHA-256
  `f2d46709c2e01a6c724852842369867be2fe3e9743dde0f0e6c4c2a0c137f8b2`.
- Storage Layout migrations 0001–0004 applied; 0005 not applied.
- Persisted `ENABLE_HARDWARE=False`, `DISPATCHER_ENABLED=False` verified by ORM
  and read-only SQL. No qcluster service. Backend gunicorn workers are HTTP
  processes, not background task workers.
- Only proxy published: `192.168.1.108:18081`; no DB/Redis public ports,
  privileged containers, devices or host mounts in the four running services.
- Filesystem has approximately 994 GiB available.
- No deployment, backup, scratch resources, migration, live writes or restart
  performed in this preparation.

## Exact proposed host program

Review **all** of `contrib/remote-development/prepare-002jq.py`. This is a new,
separately approved orchestration program, not a change to the restricted wrapper.
It invokes the unchanged backup procedure from the pinned source. It:

1. Verifies archive hash/extracted file bytes, baseline images, Compose, isolation,
   schema and disabled hardware gates; requires fresh staging/evidence paths.
2. Preserves rollback images, builds candidate tags without changing running
   images, stores private logs and exact candidate IDs.
3. Stops Development ingress and drains for 125 seconds. Takes the established
   private PostgreSQL/app-data/policy backup; records its path/checksums/schema.
4. Stops Development backend only. Restores DB to a fresh, internal-network-only
   PostgreSQL scratch container, and app-data to a fresh scratch named volume.
   No published ports, production secrets passed to PostgreSQL, host mounts or
   Docker socket access. Scratch-only trust auth is isolated by Docker network.
5. Verifies every restored media/key file byte-for-byte, rehearses migration 0005
   using candidate backend, compares all original table rows (explicit old-column
   projections for additive cabinet/drawer fields), retains evidence privately.
6. Rechecks baseline and installs fixed `:review` image tags. Activation is the
   separate existing restricted SSH command below. Leaves scratch resources for
   audit; does not delete any volumes. Before returning, starts the original
   backend/proxy by recorded ID and requires all four original services healthy.
   On failure, attempts both starts and restores both review tags to baseline;
   recovery errors annotate rather than replace the original exception. No live
   migration or automatic live DB restore occurs during preparation.

Temporary Development downtime is required during consistent backup/rehearsal.
The preparation/activation gap leaves the original services running and healthy,
not stopped pending a second command. Candidate review tags remain installed for
separate activation approval. If activation fails, stop and inspect before any
recovery; never reset the database. Do not use `recover-originals` after activation
has started: it refuses replaced containers and is not a schema rollback.

## Exact workstation commands (pending approval)

Run from `/media/spetchal/New Volume1/My-InvenTree-development-002JD`.
The orchestration script is transferred independently of the application archive;
it cannot alter the pinned application build inputs. Pin its checksum in the final
approval message before execution.

```sh
sha256sum /tmp/myinventree-002jq-image-review-56271a1ad.tar contrib/remote-development/prepare-002jq.py
scp -o BatchMode=yes -o StrictHostKeyChecking=yes /tmp/myinventree-002jq-image-review-56271a1ad.tar spetchal@mainserver-1:/home/spetchal/myinventree-002jq-image-review-56271a1ad.tar
scp -o BatchMode=yes -o StrictHostKeyChecking=yes contrib/remote-development/prepare-002jq.py spetchal@mainserver-1:/home/spetchal/prepare-002jq.py
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes spetchal@mainserver-1 'chmod 600 /home/spetchal/prepare-002jq.py /home/spetchal/myinventree-002jq-image-review-56271a1ad.tar; sha256sum /home/spetchal/prepare-002jq.py /home/spetchal/myinventree-002jq-image-review-56271a1ad.tar'
# Compare both hashes with the approval pins. Stop on mismatch.
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes spetchal@mainserver-1 'sudo -n python3 /home/spetchal/prepare-002jq.py prepare'
# Run ONLY when preparation reports READY FOR RESTRICTED ACTIVATION:
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes -i /home/spetchal/.ssh/myinventree-development-deploy_ed25519 inventree-deploy@mainserver-1 'inventree-deploy up'
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes -i /home/spetchal/.ssh/myinventree-development-deploy_ed25519 inventree-deploy@mainserver-1 'inventree-deploy status'
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes spetchal@mainserver-1 'sudo -n python3 /home/spetchal/prepare-002jq.py verify'
```

Verify running backend/frontend IDs equal `candidate-images.json`, bootstrap
exited zero, all four services healthy, hardware gates remain False, original
volumes unchanged and unrelated container identities match recorded JSON.
Do not print container environments, rendered Compose, credentials or backup data.

## Acceptance and rollback approval scope

After deployment, authenticated browser acceptance at
`http://192.168.1.108:18081/web/` must use newly created, retained isolated fixtures:
front cabinet image, two distinct drawer images, drawer/bin draw/move/resize,
image opacity/aspect/lock/visibility/history/save, refresh/navigation/restart,
non-admin/cross-cabinet denials, stale revisions and failed upload preservation.
Capture credential-free screenshots, HTTP status and geometry/native-location/
stock/active mapping/allocation before-after snapshots. A null mapping does not
prove active-mapping preservation. No controller requests, background workers or
shared-cabinet edits are permitted. No live browser result is claimed yet.

Include this exact persistence restart in approval:

```sh
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes -i /home/spetchal/.ssh/myinventree-development-deploy_ed25519 inventree-deploy@mainserver-1 'inventree-deploy restart'
```

Rollback images are `localhost/myinventree-dev-backend:rollback-002jq-56271a1ad`
and `localhost/myinventree-dev-frontend:rollback-002jq-56271a1ad`. Backup/evidence
root is `/var/backups/myinventree-dev/002jq-56271a1ad-evidence`; the timestamped
backup path and complete SHA-256 manifest are recorded there. Retain scratch
container `myinventree-002jq-restore-db`, internal network
`myinventree-002jq-restore`, and volume `myinventree-002jq-restore-media`.

**Rollback activation is not automatic or included here.** Older images cannot
serve new image features. After a post-migration failure obtain a bounded recovery
approval; retain additive schema/media and never restore a dump over live data or
delete volumes without separate explicit authorization. Main remains untouched.

## Local tooling validation and separate approvals

These commands are local-only and do not invoke Docker, SSH or privileged tools:

```sh
python3 -m unittest discover -s contrib/remote-development -p test_prepare_002jq.py -v
python3 -m py_compile contrib/remote-development/prepare-002jq.py contrib/remote-development/test_prepare_002jq.py
sha256sum contrib/remote-development/prepare-002jq.py
```

Approval must pin the final **tooling** checksum separately from the unchanged
application commit/archive above. Do not build application images from this
working tree or extract the tooling revision over the pinned application archive.
Use Python 3.11+ with `tarfile` data-filter support; never use `python -O`.

Request isolated rehearsal approval explicitly: “Approve the checksum-pinned
`prepare-002jq.py prepare` program only: candidate builds, temporary Development
ingress/backend outage, unchanged established private backup, full isolated
DB/media restore and migration rehearsal, original-service restart/health checks,
and review-tag staging. Retain scratch resources. No live migration or activation,
Main, background workers, hardware, privilege expansion or volume deletion.”
Despite the isolated restore target, this program reads live data and stops Dev
services; it is **not** an offline-only rehearsal and needs that explicit approval.
The earlier command block is a proposal, not authorization to execute it.

Only after separate activation approval run the restricted `inventree-deploy up`
command above, followed immediately by `prepare-002jq.py verify`. Verification
is read-only and fails on missing evidence, incorrect candidate images, unhealthy
DB/Redis/backend/proxy, replaced DB/Redis identities, changed mounts, failed or
incorrect-image bootstrap, absent migration 0005, enabled/missing hardware gates,
policy drift or changed unrelated full container IDs/names. Scratch DB is excluded
from unrelated comparisons. Any failure is a failed gate, never an automatic
postmigration rollback. A passing check is not browser acceptance.

For an interrupted **preactivation-only** preparation, the bounded manual recovery
command (requires explicit approval; never run after `up` has begun) is:

```sh
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes spetchal@mainserver-1 'sudo -n python3 /home/spetchal/prepare-002jq.py recover-originals'
```

It requires recorded original container identities, attempts both original starts,
restores baseline review tags, and checks all four original image/health states.
It never recreates containers or restores live data. If it refuses or fails, retain
private evidence and obtain a new bounded diagnostic/recovery approval.

### Untested limits and residual risks

- Local mocks/static checks only: no Docker, host, backup, restore, build,
  migration, deployment, restricted SSH or authenticated browser validation was
  performed for this correction. Historical inspection is not current acceptance.
- Host commands default to 900 seconds; inspection/SQL to 30 seconds; recovery
  starts to 45 seconds each. Health retries stop after a 240-second monotonic
  window, plus in-flight bounded inspections. These are per-operation limits,
  not a single end-to-end deployment deadline. Large legitimate builds/backups
  may time out and need a separately reviewed limit change.
- Failed/timed-out named scratch media/manage runs receive a bounded stop attempt.
  Killing a Docker client cannot guarantee daemon cancellation; cleanup failure
  is attached to the original error. Scratch DB/network/volume remain private for
  audit; no automated volume removal or scratch retry is attempted.
- SIGINT/SIGTERM in the disruptive block trigger recovery; SIGKILL, power loss,
  daemon failure or a second interrupt can prevent it. Manual recovery is bounded,
  not guaranteed. Fresh paths/names intentionally prevent blind reruns.
- Exclusive operator access is required throughout preparation and activation.
  Concurrent deploys, tag edits or unrelated container recreation can invalidate
  evidence; this tool does not install a host-wide operator lock or watchdog.
- Unchanged volume mounts prove identity, not data integrity or durability.
  Mount comparison is deliberately strict and may reject benign representation
  drift. Browser persistence, active-mapping preservation, restore-under-real-host
  conditions and off-host recovery remain separate acceptance gates.
