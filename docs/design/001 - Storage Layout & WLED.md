# 001 — Storage Layout & WLED

**Status:** DRAFT  
**Implementation authorised:** No

## Scope
Physical cabinets, drawers and bins; controller/output/string configuration; cabinet-wide pixel addressing; graphical cabinet and drawer layout designers; WLED locating.

## Requirements recovered from earlier design discussions — verify before approval
- [ ] Model Cabinet → Drawer → Bin independently from Controller → Output → LED String.
- [ ] Link inventory bins to native InvenTree stock locations.
- [ ] Support multiple dedicated WLED controllers per cabinet (previously discussed limit: five; confirm).
- [ ] Each controller may have multiple outputs/strings with different lengths and GPIO assignments.
- [ ] Use continuous **1-based logical cabinet-wide pixel numbering**, translated to controller/output/local pixel addresses. Never confuse logical indices with WLED's physical indexing.
- [ ] Allow a drawer's contiguous logical start/end range to span strings/controllers, with safe splitting and validation.
- [ ] Make drawer LED allocation independent of bin arrangement; bins in a drawer locate their parent drawer unless explicitly redesigned.
- [ ] Provide a graphical cabinet editor for physical drawer arrangement and a graphical drawer editor for bins.
- [ ] Support left-to-right physical drawer numbering independent of LED wiring order.
- [ ] Detect overlaps, gaps, out-of-range pixels and changed controller configurations; preserve mappings rather than silently shifting them.
- [ ] Compare saved controller configuration against WLED /json/info and /json/cfg where supported; importing or updating configuration requires an explicit action.
- [ ] Support configurable colours for locating and other functions, simulation, diagnostics, and a stop/timeout behaviour (previously discussed: two minutes).
- [ ] Editing layouts must never trigger physical WLED operations. No live hardware operations without explicit approval.

## Proposed implementation boundaries — pending source audit
- Native InvenTree: StockLocation hierarchy, parts, stock items, inventory movements.
- Plugin: cabinet/controller/string/drawer/bin geometry metadata, pixel mapping, REST endpoints and WLED integration.
- Frontend: graphical layout editors; only modify InvenTree core if existing extension points prove insufficient.

## Open design questions
- [ ] Confirm controller count and whether multiple cabinet mappings are ever needed.
- [ ] Confirm drawer numbering for irregular layouts and whether a drawer may have more than one disjoint LED range.
- [ ] Confirm WLED segment ownership, effect restoration, colour priorities and stop behaviour.
- [ ] Verify plugin-owned Django models/migrations and frontend extension points against the pinned InvenTree revision.
- [ ] Define pixel discovery/calibration workflow, offline edits, conflicts and rollback.

## Acceptance criteria and tracking
- [ ] InvenTree source audit complete
- [ ] Logical/physical mapping schema reviewed
- [ ] Graphical editor interaction design approved
- [ ] Simulation and no-hardware test cases defined
- [ ] Design approved by owner
- [ ] Implementation complete
- [ ] Tests and acceptance verified

## Change log
- 2026-10-17: Draft established from earlier discussions; requirements await confirmation.
