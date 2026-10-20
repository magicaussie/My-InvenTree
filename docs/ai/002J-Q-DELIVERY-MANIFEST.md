# 002J-Q corrected image editor delivery manifest — not deployed

- Repository: `magicaussie/My-InvenTree`
- Branch: `development/my-inventree`
- Exact corrected application source: `56271a1ada6d531ac264cf6cfc98b7b6c9aecc8a`
- Review: https://github.com/magicaussie/My-InvenTree/commit/56271a1ada6d531ac264cf6cfc98b7b6c9aecc8a
- Archive: `/tmp/myinventree-002jq-image-review-56271a1ad.tar`
- SHA-256: `0bee583df53713b8a6c92506ec41bfb3ffd385646977c0d5493f6ff87916c4ad`
- Reproduce: `git archive --format=tar --output=/tmp/myinventree-002jq-image-review-56271a1ad.tar 56271a1ada6d531ac264cf6cfc98b7b6c9aecc8a`
- Application source push to `origin/development/my-inventree` succeeded.
- This subsequent records-only commit does not change the pinned application.
  The archive includes its historical manifest; this record supersedes it without
  changing the reviewed archive bytes. Do not substitute branch HEAD for the pin.
- Owner untracked task, browser scripts, settings and five screenshots remain
  unmodified/untracked and are not in the archive.

## Scope and review

Earlier commits `fd74b155dea8eec5140c7bd3ce807429992ea5be` and
`04ad6e668777fdf1af864c1e876c6b55c9a40f94` provide secure backend media,
structure frontend retirement and independent cabinet/drawer image editors.
The corrected source additionally provides:

- Navigation API dirty/pending request protection before SPA/history transitions;
  Chromium pushState cancellation is exercised, and link/unload fallback exists.
- Image-mode Ctrl/Cmd+Z and redo scoped to editor event bubbling; text/numeric
  fields keep native undo, and unrelated page focus cannot undo image edits.
- Successful upload/ETag commit remains successful when subsequent content fetch
  fails; saved-reference/preview-error status is distinct. Decode errors also use
  preview status. Replace remains correctly labelled without a loaded preview.
- Lingui controls, status and confirmations; extracted catalogs use English
  fallback rather than unreviewed generated translations.
- Focused tests and 390px/extreme-transform browser fixture; guide and proposal
  updated. No schema change was needed for these corrections.

## Fresh verification on corrected input

From `src/plugins/storage_layout/frontend`:

| Command | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm test -- --reporter=dot` | Passed; final independent JSON run below confirms 329 tests |
| `npm test -- --reporter=json --outputFile=/tmp/002jq-review-unit.json` | success=true, 329 passed, 0 failed, 17 files |
| `npm run e2e` | 30 passed, final rerun 25.4s; translated production bundle built by harness |
| `npx biome check src/components/editor/BackgroundCanvas.tsx tests/background.test.tsx` | Passed |
| `npm run lint` | Existing formatting failure only in untouched `tests/commands.test.ts`, two long assertions |

Background unit suite has 14 tests: both targets, normalized private underlays,
CAS, pointer isolation, fit/aspect/visibility/opacity, dirty/read-only gating,
late target responses, failed replacement, pending save safety, image-only history,
shortcut focus/input isolation, navigation cancellation/revert cleanup, fallback
link cancellation/unmount cleanup and committed-upload/preview-read failure.
Browser coverage includes independent cabinet/two-drawer references, object
geometry preservation, draw-over-underlay, removal, reopen, narrow reachable save,
extreme normalized transform, keyboard undo and actual SPA cancellation.
Existing selection browser assertion passes unchanged; no independent production
hit-testing root-cause repair is claimed.

From `src/backend/InvenTree`, using `/tmp/storage-layout-venv/bin/python` and
literal disposable SQLite/media environment documented in the proposal:

- `manage.py test storage_layout.tests --exclude-tag migration_test --keepdb --settings=storage_layout.test_settings --testrunner=django.test.runner.DiscoverRunner --noinput`: **561 passed**, 52.514s.
- `manage.py test storage_layout.tests.test_migrations --tag migration_test --settings=storage_layout.test_settings --testrunner=django.test.runner.DiscoverRunner --noinput`: **7 passed**, final confirmation 23.298s.
- `manage.py makemigrations storage_layout --check --dry-run --settings=storage_layout.test_settings`: **no changes**.
- Backend regression includes populated active mapping/allocation preservation,
  without controller transport. Migration tests use a fresh disposable DB.
- `git diff --check` and commit-hook whitespace/codespell/secret checks passed.
- Existing React act and backend registry/static-fixture warnings remain.

## Schema rationale and release limits

Additive 0005 keeps separate Cabinet/Drawer FileFields and normalized JSON
metadata: independent ownership and placement, private durable references, no
external arbitrary URLs/data URLs. Fractions scale with logical canvas bounds;
images never define physical geometry, stock identity or mappings. Aggregate
root CAS protects image/layout concurrency. `Cabinet.structure` and saved data
remain; only its frontend was retired. Shared-media retention remains deliberate,
with reference-aware cleanup a separate future operation.

Proposal: [002J-Q-DEVELOPMENT-PROPOSAL.md](002J-Q-DEVELOPMENT-PROPOSAL.md).
It contains exact test environment/commands and the approval-gated Development
plan: capture current rollback images, private DB/app-data backups, isolated DB
and media restore verification, scratch migration rehearsal, reviewed builds,
bounded activation, authenticated isolated populated stock/active-mapping and
permission/conflict/restart acceptance, and non-destructive rollback.

**No deployment, privileged command, live DB change, private backup/restore, Main,
workers or hardware operation occurred.** Harness tests are fixtures, not live
Development acceptance or real durable media/restart evidence. Full navigation
protection depends on the Navigation API: older browsers only have link/unload
protection, and arbitrary programmatic SPA/history changes there are not covered.
Non-route programmatic identity replacement remains the caller's responsibility.
No comprehensive mobile/high-resolution visual audit, reviewed non-English
translations or new authenticated screenshots. Historical four broader browser
failures were not independently identified; do not claim all four repaired.
