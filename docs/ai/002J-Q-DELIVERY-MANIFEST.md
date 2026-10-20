# 002J-Q delivery manifest — image frontend implemented, review required

- Repository: `magicaussie/My-InvenTree`
- Branch: `development/my-inventree`
- Exact application source commit: `04ad6e668777fdf1af864c1e876c6b55c9a40f94`
- Review: https://github.com/magicaussie/My-InvenTree/commit/04ad6e668777fdf1af864c1e876c6b55c9a40f94
- Local archive: `/tmp/myinventree-002jq-image-ui-04ad6e668.tar`
- Exact archive SHA-256: `f87e4c2c2447ac3bae6d61aa00c24abd4ce59bb69b3d78a93d3be6025dc56b3b`
- Reproduce: `git archive --format=tar --output=/tmp/myinventree-002jq-image-ui-04ad6e668.tar 04ad6e668777fdf1af864c1e876c6b55c9a40f94`
- Application push to `origin/development/my-inventree` succeeded. This follow-up
  manifest commit changes only delivery records, not the application input.
- Archive contains tracked source only; none of the owner's untracked task,
  settings, browser scripts or five screenshots was modified/staged/archived.
- The archived tree contains the earlier historical manifest; this external
  follow-up record supersedes it without changing the pinned application bytes.

## Implementation and review

Existing `fd74b155dea8eec5140c7bd3ce807429992ea5be` supplied structure frontend
retirement and secure backend images. This continuation adds the shared
`BackgroundCanvas`, independent cabinet/drawer integration, authenticated blob
loading and revocation, normalized underlays, explicit image mode, upload,
replace, confirmed removal, move/resize/numeric controls, aspect/fit, opacity,
visibility, locks and bounded image-only undo/redo/revert/save.

Review fixed layout-reload data-loss risk: image saves adopt the returned root
ETag only, preserving any layout draft edited during the request. It also added
initial content loading gates (preventing delayed old content replacing a new
upload), request/identity guards, multipart content-type handling, forbidden
write handling, transparent image/object layers, and vertical aspect-locked resize.
Fixture API now honors requested drawer identity and retains only background
metadata in sessionStorage to exercise route/reload behavior; synthetic content
is not a real persistent media implementation.

## Fresh local verification

From `src/plugins/storage_layout/frontend`:

| Command | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm test -- --reporter=dot` | 325 passed, 17 files, 22.68s; existing React act warnings |
| `npm run e2e` | 29 passed, Chromium, 24.9s; builds real translated plugin bundle |
| `npx biome check src/components/editor/BackgroundCanvas.tsx tests/background.test.tsx src/components/CabinetDesigner.tsx src/components/DrawerDesigner.tsx src/components/editor/EditorCanvas.tsx src/state/layoutDraft.ts --write` | Final check passed; only intended changed files formatted |
| `npm run lint` | Fails only on unchanged `tests/commands.test.ts`, two long assertions requiring formatting |

New image unit tests: 10 passed, covering both target types, authenticated blob
loading, normalized placement/scaling, URL cleanup, image gesture isolation,
aspect/fit/opacity/visibility/locking, revision failure, read-only/dirty layout,
late target responses, undo/redo, failed replacement and pending-save safety.

New image browser tests: 3 passed. Cabinet and drawer workflows upload, edit/save,
reopen, draw ordinary drawer/bin rectangles over the image, save layout without
changing opacity, then remove the reference. Separate cabinet/two-drawer test
proves independent metadata. These are socket-free API fixtures, not authenticated
Django/Development acceptance or proof of distinct real uploaded media bytes.
Existing 26 tests all pass, including the formerly failing deselection assertion;
no selection assertion or production hit-testing repair was made. Layout sizing
changed with the controls, so an independent hit-testing root cause is not claimed.
Initial new-test timeouts were fixed by using explicit non-default decimal
opacity fixtures; no test was skipped or weakened.

Backend environment and exact commands are retained in the proposal. Fresh runs:

- `manage.py test storage_layout.tests --exclude-tag migration_test --keepdb --settings=storage_layout.test_settings --testrunner=django.test.runner.DiscoverRunner --noinput`: 561 passed, 51.713s.
- `manage.py test storage_layout.tests.test_migrations --tag migration_test --settings=storage_layout.test_settings --testrunner=django.test.runner.DiscoverRunner --noinput`: 7 passed, 22.414s.
- `manage.py makemigrations storage_layout --check --dry-run --settings=storage_layout.test_settings`: no changes.
- All use `/tmp/storage-layout-venv/bin/python` and explicit disposable SQLite/media
  settings, not a live DB. Regression includes populated active LED mapping and
  allocation preservation without contacting controllers.
- `git diff --check` and commit-hook whitespace, codespell and secret checks passed.

## Approval-gated Development proposal and limits

Proposal: [002J-Q-DEVELOPMENT-PROPOSAL.md](002J-Q-DEVELOPMENT-PROPOSAL.md).
It includes schema/media rationale, exact-source reconciliation, current rollback
image capture, private DB/app-data backup, isolated PostgreSQL and media restore
verification, additive migration rehearsal, bounded Development-only build and
activation, authenticated isolated populated-stock/active-mapping acceptance,
permission/conflict/restart checks, and non-destructive rollback requirements.

**No deployment, privileged commands, live DB changes, private backups, isolated
restore, Main, workers or hardware operations occurred.** The proposal remains
conditional: no activation approval is implied by local tests or a push.
Authenticated Development media/restart acceptance, full recovery validation,
narrow/mobile/high-resolution visual review, localisation of new English controls,
route-change draft-discard warning and image keyboard undo/redo shortcuts remain.
Image undo/redo buttons and browser-unload warning exist. Owner historical four
broader browser failures were not independently identified; do not claim they are
all repaired based on this local harness.
