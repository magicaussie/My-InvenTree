# 002J-K persistence regression checkpoint — 2026-10-21

## Scope

Harness state and background references now survive same-tab reloads using sessionStorage, isolated between browser contexts and default/large seeds. Drawer layout PUT preserves drawer properties and replaces only that drawer's bins. Mock responses are cloned and aggregate revision/ETag checks retained. Production application code and database schema are unchanged.

Regression coverage includes cabinet dimensions, drawer properties, independent bin layouts, save/reload/reopen/re-edit, stale/missing revisions, background revisions and session isolation. Four 390px Chromium tests cover drawer/bin mouse and real CDP touch movement/resizing, cancellation, undo/redo, saved geometry and overflow. Drag helpers now wait for actionability and sample one SVG transform, fixing a reproduced timing flake (3 failures in 20 runs before; 20/20 after).

## Validation

- `npm test`: 355 passed, 19 files.
- `npm run typecheck`: passed.
- `npm run e2e`: 38 passed after helper correction.
- `npm run lint`: existing unrelated formatting error in `tests/commands.test.ts`; unchanged. New persistence unit test lint passes; e2e is excluded by existing Biome configuration.
- Disposable Django background suite: 8 passed; API/services: 210 passed. Includes native ownership and stale revision protection; no Development ownership setting changed.
- Authenticated actual Development persistence and restricted restart passed: see `ISOLATED-CABINET-ACCEPTANCE.md` for fixture identities, geometry and precise limits.

## Deployment and remaining acceptance

No application image rebuild/activation was performed: this checkpoint changes test infrastructure and evidence only. The existing deployed application passed the focused live acceptance; no new deployment SHA is claimed. Trusted administrator image building remains outside the restricted deploy account's permissions.

Full cabinet-designer acceptance is not complete: live 390px gestures, live bin pointer gestures, drawer drawing, and live cross-owner enforcement remain unverified. Local ownership tests do not establish live enforcement while STOCK_OWNERSHIP_CONTROL is disabled. Physical calibration is not claimed. No shared data/settings, hardware, workers or Main were changed. Existing untracked files and modified user guide were preserved.

Graphical guide reviewed: no user-facing production behavior changed, so no guide edits are required for this test-only checkpoint.
