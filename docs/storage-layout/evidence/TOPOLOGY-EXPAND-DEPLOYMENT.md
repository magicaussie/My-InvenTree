# Topology and canvas — Development deployment

Development URL: http://192.168.1.108:18081/web/

## Running application

- Branch: `development/my-inventree`
- Application commit: `e8dbe88c79f53ac046e568303bbf82764e0d591b`
- Exact git archive SHA-256: `7fc229ec2694fc7814daad22c43a300fdf7e83cb5b8aa4882bcbd951ed41eaef`
- Backend image: `sha256:da928fe3ad09d8459b2c4f809473f835484e09b7195d938a8311f65086b1a063`
- Frontend image: `sha256:86ecb1348a823b8a24d4bdc0ab689dca86f17b5708c326cabe646330693bd21e`

The trusted `spetchal@mainserver-1` administrator path built and staged both
images using the established workspace build procedure, pinned to the archive.
Activation used `inventree-deploy@mainserver-1` with canonical
`inventree-deploy up`. Exact activation verification passed after live acceptance:
healthy services, bootstrap success, expected images, migration 0005, unchanged
persistent mounts/db/redis identities and unrelated containers, hardware gates off.
Host evidence: `/var/backups/myinventree-dev/workspace-e8dbe88c7-evidence`.

Original backup `/var/backups/myinventree-dev/20261020T091716Z`, previous rollback
images and database/media volumes retained. No new restore/rehearsal claimed.
No Main, physical controllers, workers, database reset, volume deletion, access
policy changes or existing shared-record mutations. Test controllers are disabled
and use reserved TEST-NET origins. Isolated acceptance fixtures are retained.

## Fixes

New topology entities submit null IDs; server UUIDs are retained on subsequent saves.
Canvas expansion has native and in-page fallback paths, retaining the mounted
canvas and unsaved state. Escape is captured before host handlers.
Background drafts verify persisted metadata and image bytes before adopting the
revision after a local layout save; genuine background conflicts retain CAS safety.

## Validation

- TypeScript: passed, including final source.
- Full frontend suite after background fix: 342 tests passed.
- Final focused canvas/background/topology suites: 35 tests passed.
- Backend plugin suite: 562 passed; migration suite: 7 passed.
- Migration drift check: no changes detected.
- Authenticated live acceptance: 23 checks, PASS_WITH_GAPS.
- Exact activation verification passed again after acceptance.

Live report and screenshots:
`topology-expand-0c0cedd7-eea4-4465-859d-915ae103b8d0/report.json`.
This report's application SHA is an operator attestation; separate administrator
activation verification supplies exact deployment provenance.

Verified UI controller/output/string creation, first save, second save, UUID
preservation and reload; cabinet and two independent drawer image uploads,
transforms, save/reload, replacement and removal; native and fallback expansion,
button exit, fallback Escape, canvas identity, zoom and unsaved-state preservation.
Actual unsaved cabinet layout movement survived expansion and saving; saving image
metadata after that layout save passed. Existing cabinet-list snapshots matched.

Limit: headless Chromium did not deliver native fullscreen Escape reliably;
explicit browser fullscreen API exit was used in those three cases. Native Escape
is not claimed verified. Live ownership denial with ownership control enabled and
390px override object gestures remain outside this acceptance; no shared settings
were changed. Acceptance runner corrections addressed tab selection, unique dummy
origins, server image sanitization, confirmations, selection styling and aggregate
revision normalization; these are test-only changes, not additional application fixes.
