# Isolated live cabinet acceptance — 2026-10-21

Runner: `contrib/remote-development/live-layout-isolated-acceptance.cjs`.
Copied from, without modifying, the owner's untracked follow-up runner.
No application code/image changes, builds, commits or pushes.

## Executed validation

```sh
node --check contrib/remote-development/live-layout-isolated-acceptance.cjs
SL_CHROMIUM_PATH=/home/spetchal/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome node contrib/remote-development/live-layout-isolated-acceptance.cjs
```

Both passed for the final runner. Authenticated actual Development browser/API
execution, not harness persistence. Each final-run invocation creates its own
cabinet/root location and retains all fixture records. URL is pinned to Development.
Credentials use the existing in-memory retrieval mechanism and are not recorded.

Final fixture: `b4f7ee01-3aa8-42c8-aaf4-eb0cdf5740a6`.

- Cabinet dimensions saved/reloaded: 641 × 841 logical units.
- Add and Duplicate drawer saved/reloaded with distinct automatic structural native
  locations 375 and 376 beneath the fixture root.
- Zoom, fit/reset and middle-button pan passed.
- CTM-scaled drawer move at fitted non-100% zoom produced exactly
  `[0,0,60,40] → [30,30,60,40]`; undo/redo restored/reapplied geometry.
- Scaled southeast resize produced `[30,30,80,60]`, followed by backend save.
- Reload, select and re-edit drawer width to 79 passed; sibling record unchanged.
- Automatic bin location 377 verified non-structural beneath drawer location 375.
- Bin save, reload, select, re-edit width 20 → 21, save and reload passed.
  Both drawer records unchanged by bin edits; sibling drawer bins remained empty.
- Archive confirmation/save/reload passed for the duplicate drawer.
- Restricted `inventree-deploy restart` used the dedicated deployment key. Actual
  API health returned 200; cabinet browser reloaded. Exact normalized cabinet,
  drawer and bin identity/location/geometry/archive snapshots matched before/after.
  Two successful runs each performed one restricted restart.

Final retained snapshot:

| Entity | Native location | Geometry x,y,width,height | Archived |
|---|---:|---|---|
| Drawer 07992428-02b4-4f8b-b3f7-062e31c052d0 | 375 | 30,30,79,60 | false |
| Drawer f2a10774-4790-4b54-b49b-9a3a82d4b454 | 376 | 400,500,60,40 | true |
| Bin 8f28b2aa-57f9-4f1c-ad83-74ebb8194db2 | 377 | 0,0,21,20 | — |

## Intermediate evidence and limits

- Authorized original empty fixture `7b27a803-2ca9-45e7-9c17-e3a7d4999b05`
  passed dimension edits and automatic Add/Duplicate save/reload. A second stale
  selector, `Draw drawer`, timed out after pan. Fixture retained with two drawers.
- Fresh fixture `98d6da9e-f794-4d2f-bed7-3261d0498362` retained after a move
  assertion failed: zooming from reset displaced the pointer target. Fitting before
  CTM-derived targeting corrected the runner; no application fix was needed.
- Fixture `c2cba010-cb13-4eb8-a91e-0af79fa9a5de` passed the initial focused run
  including restart; final run added explicit reload/re-edit and sibling isolation.
- Drawer drawing is deliberately not claimed by this focused runner. Bin pointer
  move/resize, physical calibration, permissions, populated stock/active mapping,
  cross-owner controls and global shared-record snapshot preservation are not tested.
- No hardware endpoints/actions, workers, Main, shared-record writes, deletes,
  settings/gate changes, image builds or policy changes were performed. Hardware
  gates were not independently re-read in this acceptance; prior documented off
  state is not presented as newly verified runtime evidence.
- Guide reviewed: automatic native locations and logical units already documented;
  no user-facing behavior changed, so the owner's modified guide was left untouched.
