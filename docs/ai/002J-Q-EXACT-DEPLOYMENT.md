# 002J-Q exact Development deployment approval request

Status: **NOT EXECUTED — owner approval required**. Application input is only
`56271a1ada6d531ac264cf6cfc98b7b6c9aecc8a`, never branch HEAD.

## Read-only inspection, 2026-10-20

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
   audit; does not delete any volumes. On preactivation failure starts only the
   original backend/proxy and stops with evidence; no automatic live DB restore.

Temporary Development downtime is required during consistent backup/rehearsal.
Do not interrupt between successful preparation and restricted activation. If
activation fails, stop and inspect before any recovery; never reset the database.

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
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes spetchal@mainserver-1 'sudo -n python3 /home/spetchal/prepare-002jq.py'
# Run ONLY when preparation reports READY FOR RESTRICTED ACTIVATION:
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes -i /home/spetchal/.ssh/myinventree-development-deploy_ed25519 inventree-deploy@mainserver-1 'inventree-deploy up'
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes -i /home/spetchal/.ssh/myinventree-development-deploy_ed25519 inventree-deploy@mainserver-1 'inventree-deploy status'
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes spetchal@mainserver-1 'sudo -n docker inspect --format "{{.Name}} {{.Image}} {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}" myinventree-dev-backend-1 myinventree-dev-proxy-1; sudo -n docker exec myinventree-dev-db-1 psql -U inventree -d inventree -Atc "SELECT app,name FROM django_migrations WHERE app='\''storage_layout'\'' ORDER BY name"'
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
