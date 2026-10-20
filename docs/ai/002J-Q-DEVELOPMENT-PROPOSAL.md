# 002J-Q — image frontend implementation and Development-only proposal

## Decision: NOT READY FOR ACTIVATION

This source retires the Structure frontend and implements the secured image
backend plus cabinet/drawer canvas controls. Local verification is not full release
acceptance: the authenticated Development and recovery gates below remain pending. The existing
Development deployment has not been modified. No authenticated live browser,
service restart, migration, backup, restore, privileged command, controller action,
worker activation or Main operation was performed in this task.

Exact application source commit and archive hash are recorded in the
[delivery manifest](002J-Q-DELIVERY-MANIFEST.md) added after the implementation commit. Do not substitute branch HEAD or
assume a documentation commit has been built. An archive is not build approval.

## Implemented contract and schema rationale

- Additive `0005_background_images`: `background_image` FileField (empty by default)
  and `background_metadata` JSONField (`{}` by default), independently on Cabinet
  and Drawer. No data migration, no removal of `Cabinet.structure`, and no new
  stock entities. FileField delegates durable storage to the configured Django
  backend; JSON keeps optional reference presentation separate from geometry.
- Metadata read defaults: x/y 0; width/height 1; opacity 0.5; visible true; locked
  true; aspect_locked true. Position and size are fractions of the current canvas
  dimensions. Canvas resizing scales each axis independently without modifying
  the stored transform. Aspect lock is editor intent, not an automatic backend
  constraint or physical calibration. Replacement preserves metadata.
- `GET/POST/PATCH/DELETE /plugin/storage-layout/api/v1/{cabinets|drawers}/{id}/background/`.
  POST accepts multipart `image`; PATCH accepts the full metadata object, not a
  URL. All mutations require the root cabinet If-Match revision and increment
  that aggregate revision. Metadata rejects unknown fields, non-finite values,
  invalid sizes and out-of-range opacity. Position is bounded to [-10,10]; size
  to [0.0001,20] canvas fractions.
- `GET .../background/content/` authenticates and checks the same native-location
  ownership as the layout endpoints. It streams PNG, private/no-store/nosniff,
  without disclosing storage paths. No external URLs/base64 accepted. Authorized
  content URLs are relative; a future frontend must fetch through the supplied
  authenticated API client (not assume an img request carries token headers).
- Uploads: PNG/JPEG/WebP only; exact declared MIME/content match; <=8 MiB input
  and re-encoded output; <=20 million pixels; no animation. Decode and re-encode
  to PNG strips embedded metadata and trailing non-image content. Generated UUID
  filenames prevent client-controlled paths.
- Old files are deliberately retained. `django-cleanup` is disabled on Cabinet
  and Drawer because per-row deletion is unsafe for shared references. Failed
  transactions remove only their own newly allocated file. A process crash
  between storage write and DB commit may still leave an orphan; future cleanup
  must audit references across both models, have retention/grace periods and be
  separately reviewed. Do not run ad-hoc storage deletion.
- Structure UI, opening reference state/helpers/types, API write helper and
  obsolete tests were removed. Backend structure endpoints/data remain usable
  by compatible older clients. Eventual structure cleanup requires a separate
  migration, backup and owner decision.

## Validation performed locally

Backend used `/tmp/storage-layout-venv/bin/python` and an explicitly disposable
SQLite configuration, never a live database. Commands use this environment:

```sh
INVENTREE_DB_ENGINE=sqlite3
INVENTREE_DB_NAME=/tmp/storage-layout-002jq.sqlite3
INVENTREE_MEDIA_ROOT=/tmp/storage-layout-test-data/media
INVENTREE_STATIC_ROOT=/tmp/storage-layout-test-data/static
INVENTREE_BACKUP_DIR=/tmp/storage-layout-test-data/backup
INVENTREE_SITE_URL=http://localhost
INVENTREE_PLUGINS_ENABLED=true
INVENTREE_PLUGIN_TESTING_SETUP=true
```

Set/export those literal environment assignments only in the local test shell.
From `src/backend/InvenTree`:

```sh
/tmp/storage-layout-venv/bin/python manage.py test storage_layout.tests --exclude-tag migration_test --keepdb --settings=storage_layout.test_settings --testrunner=django.test.runner.DiscoverRunner --noinput
/tmp/storage-layout-venv/bin/python manage.py test storage_layout.tests.test_migrations --tag migration_test --settings=storage_layout.test_settings --testrunner=django.test.runner.DiscoverRunner --noinput
/tmp/storage-layout-venv/bin/python manage.py makemigrations storage_layout --check --dry-run --settings=storage_layout.test_settings
```

Results: **561 backend tests passed** (52.587s); **7 migration tests passed**
(21.147s); migration drift check reported no changes. Full suite includes new
permission/ownership seams, real multipart decoding and MIME rejection, size and
transform limits, CAS/missing revision, failure rollback/media cleanup, independent
cabinet/drawer references, shared reference retention, and populated active-mapping,
pixel-span/allocation and drawer-geometry preservation. Ownership denial tests
patch the existing ownership seam; they are not live non-admin browser evidence.
An earlier targeted 7-test command timed out at 30 seconds during DB setup; the
subsequent complete suite with its normal 120-second bound passed all 561 tests.
The final focused background suite also passed all 7 tests (0.454s), including
the final explicit unsupported-format guard.
Registry/static-fixture warnings and expected error-response logs occurred; no
hardware sockets were opened by these tests.

The requested `invoke dev.test --settings=...` syntax is unavailable in this
checkout: `invoke dev.test --help` has no settings option. The direct Django
runner above was used instead.

From `src/plugins/storage_layout/frontend`:

- `npm run typecheck`: passed.
- `npm test -- --reporter=dot`: **315 passed, 16 files**. Some pre-existing
  React act warnings remain.
- `npx biome check src/components/CabinetDesigner.tsx src/api/client.ts src/api/types.ts tests/designer.test.tsx`:
  passed for changed frontend source/unit test files.
- `npm run lint`: fails on pre-existing formatting in unchanged
  `tests/commands.test.ts` (two long assertions). Not silently reformatted.
- `npm run e2e`: **25 passed, 1 failed** in the final fixture Chromium run.
  The harness builds the real plugin with translation extraction/compilation;
  it is not authenticated Development acceptance.
- The initial harness run had 7 failures. Fixed harness pixel/logical-unit
  assumptions with actual screen CTMs, stale Layout tab label, missing translation
  extraction, and stale handle position after Escape/refit. These repairs preserve
  the assertions rather than disabling/skipping tests. Remaining failure:
  `e2e/canvas.spec.ts` → `zoom keeps painted bounds and allocation overlays aligned
  and background clears selection`: empty-space click retains one resize handle
  (expected zero). Root cause not proven; inspect hit-testing and clipped screen
  coordinates before modifying production canvas behavior. Do not claim the
  owner's historical four failures are exactly reproduced or all resolved.
- Final Ruff check of changed Python files and `git diff --check`: passed.

## Frontend completion follow-up — local results (2026-10-20)

`BackgroundCanvas.tsx` is shared by CabinetDesigner and DrawerDesigner, keyed by
target identity. It loads content using the host authenticated Axios client and
creates/revokes private blob URLs; returned URLs are never followed. It renders
normalized image geometry below transparent drawer/bin overlays. Explicit image
mode isolates pointer/keyboard object gestures and provides labelled numeric
controls, move/resize, fit, visibility, opacity, lock/aspect lock, bounded separate
undo/redo, revert, immediate upload/replace/confirmed removal and explicit metadata
save. Busy/failed/dirty states are visible. Failed replacements keep the previous
image. A late target response is ignored. Save controls freeze the image draft;
image save callbacks update only the root ETag, never reload or replace concurrent
layout edits. Dirty layout blocks starting image mutations; concurrent aggregate
writes still receive authoritative CAS protection. Unsaved image edits are not
persisted to local storage; save/revert before route changes.

Fresh complete local runs (same backend environment and commands above):
- Backend regression: **561 passed**, 51.713s, including populated active mapping
  and pixel allocation preservation; no controller transport is contacted.
- Migration suite: **7 passed**, 22.414s. Migration drift: no changes.
- Frontend `npm run typecheck`: passed.
- Frontend `npm test -- --reporter=dot`: **325 passed, 17 files**; new
  image tests cover both normalized layers, dimensions, authenticated content,
  locks/aspect/fit/visibility/opacity, CAS failure, target switching, URL cleanup,
  undo/redo, failed replacement and pending-save/intervening-layout safety.
- `npm run e2e`: **29 passed**, final rerun 24.9s. Existing 26 all pass, including the formerly failing deselection
  test. Its assertion/hit-testing code was not changed: new layout sizing made it
  pass; this is not proof of an independently repaired hit-testing root cause.
- New browser tests cover upload/edit isolation, metadata save, reopen, removal,
  drawing drawers/bins over images, and independent cabinet/two-drawer metadata.
  Fixture sessionStorage retains image metadata only. It is not Django/media
  persistence or authenticated live evidence; fixture content uses a synthetic PNG.
- Two initial independent-image browser attempts timed out: first selected an
  unchanged default opacity (Save correctly disabled); second entered an unsafe
  floating-point string Mantine did not emit as a number. Explicit decimal fixture
  values resolved it. Review also fixed the fixture drawer endpoint, which had
  always returned drawer 1 instead of the requested drawer.
- Changed-source/unit Biome checks and `git diff --check`: passed. Full lint still
  fails only on unchanged `tests/commands.test.ts` formatting (two assertions).
  Existing React act and backend registry/static-fixture warnings remain.

## Remaining release gates and limitations

1. Human review and authenticated isolated Development acceptance with two real,
   distinct drawer images, actual populated stock and active mapping snapshots,
   low-permission/cross-owner denial, stale CAS and approved restart persistence.
2. Backup and isolated DB/media restore verification under the existing trusted
   mechanism; no recovery/deployment commands were executed in this task.
3. Narrow/mobile visual acceptance, extreme-aspect/high-resolution visual checks,
   localisation of new English image controls, route-change draft-discard warning
   (browser unload is guarded), and image keyboard undo/redo shortcuts (buttons
   exist; layout shortcuts do not receive image-focus keystrokes).
4. No new authenticated screenshots. Updated guide diagram is illustrative. The
   owner's historical four broader browser failures were not independently
   identified; do not equate them with the now-passing 26-test local harness.

## Proposed exact Development-only build/activation sequence — approval required

Do not execute this sequence now. First review this exact application archive and the remaining gates above, and
obtain owner approval for that artifact and bounded Development-only commands.
The manifest pins the reviewed source; this proposal is not execution approval.

1. Freeze the reviewed application commit. Produce `git archive --format=tar` of
   that exact commit; SHA-256 the resulting bytes. Review tracked-only contents,
   excluding owner task/settings/screenshots, DB dumps, credentials and generated
   browser artifacts. Administrator reconciles staged bytes with this archive.
2. Owner/administrator records actual currently running Development backend and
   frontend image IDs/digests and preserves rollback tags before builds. Historical
   IDs in DEPLOYMENT.md are evidence of prior checkpoints, not newly inspected
   runtime state. Reconcile installed Compose with the reviewed source; do not
   print rendered Compose, environment, secrets or tokens.
3. Pause Development writes for application-consistent DB and app-data snapshots.
   Reuse ONLY the established administrator-reviewed private `backup-verify.py`
   mechanism in DEPLOYMENT.md. Preserve PostgreSQL custom dump, full app-data
   media/static/keys, runtime/policy copies in restricted backup storage. No new
   privilege grant, Docker socket exposure or deployment-account exec access.
4. Before migration, verify the dump restores into ONLY the approved isolated
   scratch DB (`dev_002jl_restore_verify` under the existing mechanism), never the
   live DB or Main. Verify representative cabinet/drawer/bin identities, structure,
   stock/native locations, populated mappings and allocations. Fully read the
   app-data archive. A full media restore was historically not exercised: propose
   a separately approved isolated replacement stack/volume, restore media there,
   and verify image references/content and keys before claiming media recovery.
   Never overwrite live media or print backup contents/secrets.
5. Administrator builds reviewed Development images, including Lingui extraction
   before compilation; records image IDs and build logs. Review additive 0005 on
   the scratch restoration before live Development migration. No worker service.
6. Only after explicit approval, administrator installs reviewed image tags and
   invokes the existing restricted Development lifecycle. Keep
   ENABLE_HARDWARE=False and DISPATCHER_ENABLED=False; re-read gates without
   controller I/O. Do not deploy Main, contact WLED, enable workers, delete
   volumes, change firewall/CasaOS or restart unrelated services.
7. Authenticated acceptance uses newly created, isolated, audit-retained fixtures.
   Use a low-permission account as well as an editor; prove denied writes and
   cross-owner media reads, stale CAS, images across refresh/reopen/restart and all
   before/after safety snapshots. Do not edit shared cabinets for screenshots.
   Credentials remain in memory and out of logs. Obtain separate approval for
   lifecycle persistence verification; fixture harness results are not live proof.
8. On failure, stop acceptance and preserve evidence. Administrator restores the
   captured rollback image tags using existing policy, never deletes volumes.
   Older images can ignore additive image fields; database rollback is NOT assumed
   safe. Test old images against the scratch restored DB first. Any restoration
   over live data needs new explicit approval; keep image/media DB references
   consistent, never downgrade or delete the structure/image columns ad hoc.

No deployment, private backup or isolated restore has been executed for 002J-Q.
