# 001 — Storage Layout & WLED

**Status:** IMPLEMENTED FOR LOCAL DEVELOPMENT AND SIMULATION — stages 1–4 implemented; integrated local QA recorded in §17. Production/cross-database qualification and human hardware commissioning are not complete. No physical hardware acceptance is claimed.

**Implementation authorised:** Yes — the owner's CONTINUE PROJECT 001 instruction authorises implementation and safely defaultable development/simulation decisions. It explicitly forbids physical controller access and production deployment. §16 recommendations are development defaults, not permission for live operation.

**Repository / branch:** `magicaussie/My-InvenTree` / `master`

**Source baseline:** `c701d8efb9e9a59e05071ce2f62537251f7ccf39` (clean worktree at investigation start)

**Reviewed:** 2026-10-17; InvenTree `1.6.0 dev`, UI library `@inventreedb/ui` `1.6.0`

**Implementation reviewed:** 2026-10-18; plugin package `src/plugins/storage_layout` (`inventree-storage-layout` `0.1.0`, plugin slug `storage-layout`). See [Implementation status](#17-implementation-status) below.

## 1. Purpose, scope and requirement provenance

Add an accurate visual representation of storage and a safe locating service without replacing InvenTree inventory management. This is an implementation-ready **proposal**, not approval of previously tentative product choices or permission to implement or operate hardware.

### Confirmed requirements

The current task confirms the following, superseding the original document's unverified requirement checklist:

- Physical Cabinet → Drawer → Bin and electrical Controller → Output → LED String are independent hierarchies, joined through an explicit logical pixel map.
- Multiple dedicated controllers per cabinet, multiple outputs per controller, unequal string lengths and GPIO configuration must be represented.
- Cabinet logical pixels are continuous, **1-based**; a drawer has one inclusive contiguous logical range which may cross strings, outputs and controllers.
- Bins link to native inventory storage locations and normally inherit their drawer's locating behaviour. Moving/resizing bins does not change LED allocation.
- Separate graphical cabinet and drawer/bin designers support creation, positioning, resizing, validation and saving. Human drawer numbering is independent of wiring.
- Detect overlaps, gaps, invalid bounds and controller configuration drift. Never silently renumber existing allocations.
- Provide explicit configuration observation/import/update, configurable locating colours, testing/calibration, simulation, connection handling, timeouts and safe conflict/stop handling.
- Layout editing never performs hardware operations. This investigation must not access any physical controller. Preserve existing WLEDger and its data.
- Reuse native inventory, authentication, permissions and UI extension facilities wherever verified; no application implementation in this task.

The earlier discussion's **five-controller limit**, **two-minute timeout**, irregular-layout numbering and state-restoration preferences remain owner decisions (§16). Recommendations below make the design implementable, but must not be represented as historical agreements.

### Boundaries

Included: plugin-owned geometry, mappings, configuration observations, validation, graphical editors, safe locate/test command service and simulation. Excluded: parts catalogue, quantities, movement ledger, purchasing, label formats, global search, WLEDger extraction/cutover, WLED firmware flashing, power-supply engineering, general-purpose lighting/effect choreography and automatic hardware reconfiguration. Coordinate with projects 002/003/005/006/007/008/009/010/011; do not wait for them to implement the pure model/editor/simulator stages.

## 2. Source audit and extension feasibility

Paths below are repository-relative and refer to the baseline above. Symbols, rather than unstable line numbers, identify the contracts. These are **existing source**, not proposed implementation files.

| Concern | Verified source and contract | Design consequence |
|---|---|---|
| Version and tooling | `src/backend/InvenTree/InvenTree/version.py`: `INVENTREE_SW_VERSION`; `src/frontend/package.json`; `CONTRIBUTING.md`; `tasks.py`; `pyproject.toml` | Pin against this development revision; Python ≥3.12, Django/DRF, Django-Q2, React 19/Mantine 9/Vite, TanStack Query, Lingui and Playwright. Do not assume compatibility with all InvenTree releases. |
| Locations | `src/backend/InvenTree/stock/models.py`: `StockLocation`, `StockLocationType`; `src/backend/InvenTree/InvenTree/models.py`: `InvenTreeTree`, `PathStringMixin`, `MetadataMixin` | Native hierarchical locations, structural/external flags, ownership, paths, types, barcodes and plugin validation already exist. No native rectangle or LED schema. Use real FKs, not JSON metadata as the primary database. |
| Stock and movement | `src/backend/InvenTree/stock/models.py`: `StockItem.location`, `StockItem.move`, `StockItemTracking`; `src/backend/InvenTree/stock/events.py`: `StockEvents.ITEM_MOVED` | Native move handles splitting and tracking; locating reads the item's current location. Never duplicate quantities, parts or tracking and never move stock by changing plugin geometry. |
| Native API | `src/backend/InvenTree/stock/api.py`: `StockLocationList`, `StockLocationDetail`, `StockLocationTree`, `StockTransfer`, `StockTrackingList`; `src/backend/InvenTree/stock/serializers.py`: `LocationSerializer`; `stock_api_urls` in that API module | Reuse native location picker/tree, inventory detail and stock transfer endpoints. Plugin APIs only manage the new domain. |
| Migration baseline | `src/backend/InvenTree/stock/migrations/0125_remove_mptt_fields.py`, `0128_remove_stockitem_notes.py` | Latest inspected stock migration is 0128. The former removes tree fields from **StockItem**, not StockLocation; location hierarchy still uses `InvenTreeTree`. Do not copy stale StockItem notes/tree assumptions into plugin schema. |
| Custom Django app | `src/backend/InvenTree/plugin/base/integration/AppMixin.py`: `_activate_mixin`; `docs/docs/plugins/mixins/app.md`; `docs/docs/plugins/install.md` | AppMixin really adds the plugin package to `INSTALLED_APPS`; plugin models and migrations are supported, with lifecycle/version risk. Apply migrations in maintenance deployment, then restart server/workers. Enabling a plugin is not a migration strategy. |
| Plugin routes | `src/backend/InvenTree/plugin/base/integration/UrlsMixin.py`; `src/backend/InvenTree/plugin/urls.py`: `get_plugin_urls`; `src/backend/InvenTree/InvenTree/urls.py` | Plain Django patterns can contain DRF views under `/plugin/<slug>/`. They are **not automatically** `/api/plugin/…`. |
| Permissions | `src/backend/InvenTree/users/permissions.py`: `check_user_permission`; `src/backend/InvenTree/InvenTree/permissions.py`: `RolePermission`, `IsAuthenticatedOrReadScope`; app-mixin docs | Non-core model checks support Django permissions and a model classmethod fallback. Implement explicit API/object policies; do not mistake plugin loading or menu visibility for authorisation. |
| Existing locate hook | `src/backend/InvenTree/plugin/base/locate/mixins.py`: `LocateMixin`; `src/backend/InvenTree/plugin/base/locate/api.py`: `LocatePluginView`; `src/frontend/src/components/plugins/LocateItemButton.tsx` | Native `/api/locate/` asynchronously passes **only item/location PK**, not actor, approval, colour or session ID. Native stock/location buttons exist, but do not provide the richer safe command contract (§3). |
| Background work | `src/backend/InvenTree/InvenTree/tasks.py`: `offload_task`, `schedule_task`; `src/backend/InvenTree/plugin/base/integration/ScheduleMixin.py`; `src/backend/InvenTree/plugin/base/event/mixins.py` | Reuse Django-Q2 and scheduled reconciliation. Events are optional cache invalidation, never automatic lighting on stock movement. |
| Validation | `src/backend/InvenTree/plugin/base/integration/ValidationMixin.py`: `validate_model_instance`, `validate_model_deletion`; `InvenTree/models.py`: `PluginValidationMixin` | Add friendly native location reparent/delete guards. ORM bulk updates may bypass clean/hooks; revalidate at every execution boundary. FKs independently protect deletion. |
| Plugin UI declarations | `src/backend/InvenTree/plugin/base/ui/mixins.py`: `UserInterfaceMixin`, `get_ui_routes`, `get_ui_panels`, `get_ui_navigation_items`, `get_ui_primary_actions`; `src/backend/InvenTree/plugin/base/ui/api.py` | Routes, navigation, additive panels and primary actions exist; no core page replacement is needed. |
| UI consumers | `src/frontend/src/router.tsx`; `src/frontend/src/components/plugins/PluginRoutes.tsx`, `PluginContext.tsx`, `RemoteComponent.tsx`; `src/frontend/src/hooks/UseRemotePlugin.tsx`, `UsePluginPanels.tsx`; `src/frontend/src/pages/stock/LocationDetail.tsx` | Plugin route prefix is `plugin/<plugin_name>/<options.path>` within the SPA base. Location detail supports stocklocation plugin panels. Entry functions accept one context argument (or legacy two-argument mount). |
| Public UI SDK | `src/frontend/lib/index.ts`; `src/frontend/lib/types/Plugins.tsx`; `docs/docs/plugins/frontend.md` | Use public exports/context: authenticated API, query client, navigation, forms/tables, rendering, theme/i18n. Do not deep-import host application internals. Externalise host-shared React/Mantine/Lingui per plugin build guidance. |
| Editor precedent | `src/frontend/src/components/dashboard/DashboardLayout.tsx`; `src/frontend/src/components/editors/TemplateEditor/TemplateEditor.tsx` | Dashboard drag/resize and split editor patterns exist, but no physical storage designer exists. Build a small SVG rectangle editor inside the plugin; dashboard responsive compaction is wrong for fixed physical geometry. |
| Tests | `src/backend/InvenTree/stock/test_api.py`; `src/backend/InvenTree/plugin/samples/locate/locate_sample.py`; `src/frontend/tests/pui_plugins.spec.ts`, `baseFixtures.ts`, `settings.ts`; `src/frontend/playwright.config.ts` | Reuse Django/DRF and Playwright conventions, plugin enablement helpers and console-error checks. |
| Feature gates | `src/backend/InvenTree/common/setting/system.py`: `ENABLE_PLUGINS_APP`, `ENABLE_PLUGINS_URL`, `ENABLE_PLUGINS_INTERFACE`, `ENABLE_PLUGINS_SCHEDULE` | These default off. Installation must explicitly enable required facilities in addition to global plugin activation; optional events need `ENABLE_PLUGINS_EVENTS`. Modern UI navigation uses the interface feature endpoint; legacy NavigationMixin's separate `ENABLE_PLUGINS_NAVIGATION` gate is not required for this design. |
| Barcode/security | `src/backend/InvenTree/plugin/base/barcodes/api.py`, `mixins.py`; `docs/docs/concepts/threat_model.md` | Reuse location/item barcodes and scanner resolution. Trusted plugins are not sandboxed; constrain hardware egress and minimise credentials. |

### Investigation findings and limitations

No tracked WLED implementation or WLEDger data was identified in this repository; preservation is a constraint, not evidence of a tested migration. WLEDger behaviour/import reconciliation remains project 006. Four parallel DeepSeek V4.1 Flash workers investigated backend, frontend, WLED and schema/test requirements; lead review corrected or narrowed suggestions where source/safety required it (notably native locate actor loss, unstable WLED config, and implicit renumbering).

**Design expectation: no core changes.** Implementation uncovered one host plugin-module reload defect; §17 records the narrowly scoped registry fix and two plugin-aware core test adjustments. Inventory models, migrations, host router and permission behaviour remain unchanged. Package a trusted installable plugin in this repository, proposed future root `src/plugins/storage_layout/`, Python app label `storage_layout`, plugin slug `storage-layout`, with its own frontend build/assets. This path does not yet exist. Do not alter stock models/migrations or host router. AppMixin, UrlsMixin, UserInterfaceMixin, SettingsMixin, ScheduleMixin and ValidationMixin suffice. A bounded HTTP adapter is preferable to assuming APICallMixin's single base-URL setting models many controllers.

## 3. Architectural decisions

1. **Native locations own inventory identity.** A cabinet, each drawer and each bound bin represent native StockLocations. Cabinet and drawer locations are required structural containers; bins may remain unbound in a work-in-progress geometry layout, but cannot then resolve inventory. A bound bin is a non-structural internal location. Default native parent links exactly mirror cabinet → drawer → bin; cabinet location may have any suitable native ancestor. Existing unrelated location trees remain untouched.
2. **Geometry never owns stock.** Assigning an existing location to a bin requires the correct native parent; do not silently reparent it. Offer a separate native location edit/create workflow, with native permissions, followed by explicit binding. Rebinding an occupied bin warns that its stocks stay with the old location; it is not a transfer. Moving a bin between drawers requires an explicit relocation/reparent workflow and permission, not drag across canvases in v1.
3. **Electrical topology has no Drawer/Bin FK.** Controllers belong to exactly one cabinet in v1 (dedicated ownership); outputs belong to controllers; strings belong to outputs. Only DrawerAllocation and PixelSpan join physical/logical/electrical concerns. No stored per-pixel rows: contiguous affine spans are sufficient and avoid thousands of redundant records.
4. **Logical identity is explicit and stable.** PixelSpan has a saved logical start. Ordering output rows must not regenerate it. Publishing a mapping requires full coverage `1..N`; removing/replacing hardware preserves the old mapping until an explicit, reviewed replacement is valid. Drawer allocation gaps are reported as unused LEDs, not confused with illegal mapping holes.
5. **One live locate per cabinet in v1.** Atomic cabinet reservation covers every controller involved; overlapping/disjoint requests both return busy rather than introduce colour-priority complexity. Different cabinets may operate concurrently. All HTTP for a given controller is serialised.
6. **Hardware is opt-in and separately authorised.** Default is simulation. Explicit arm + explicit Locate/Test approval are required. No autosave, layout save, mapping publish, import, event or ordinary page view may issue controller HTTP. Explicit Observe is a separate read-only hardware operation; optional polling needs an operator-enabled read grant.
7. **Native locate limitation is intentional, not hidden.** Do **not register LocateMixin for live use in v1**: `LocatePluginView` loses the initiating user before invoking it, so it cannot enforce this design's operate permission, approval or audit attribution. Provide plugin primary actions/panels on location/stock pages calling our authenticated session API instead. Reuse native item/location resolution and UI placement, not a bypassable native live hook. A future actor-aware core contract is optional enhancement, not a dependency or justification for core modification now.
8. **Dedicated-controller black-on-stop policy.** No automatic restoration of arbitrary external effects, presets or frozen individual pixels. `seg.i` is write-only; a GET snapshot cannot restore that framebuffer. Refuse external realtime/playlist ownership; surface conflicts. Proposed v1 takes explicit exclusive ownership and clears to black/off, not generic shared lighting. Owner approval required (§16).

## 4. Database schema

All following models are **proposed plugin models**, not current InvenTree features. Use UUID PKs, UTC created/updated timestamps and `created_by`/`updated_by` nullable FKs to `AUTH_USER_MODEL` (`SET_NULL`) on user-editable roots. Use Django positive integers for counts/indices, bounded strings (names 100, labels 64, hashes 64), JSON only for bounded snapshots/plans/errors. Every mutable cabinet aggregate has monotonic `revision` (64-bit positive integer, initial 1). `Cabinet.revision` is the sole aggregate CAS/ETag counter; `MappingRevision.number` increments only when creating a mapping revision; `Controller.desired_revision` records the cabinet revision at its last desired-configuration change, not a separate CAS authority. Distinguish desired configuration from observed hardware.

### 4.1 Storage and mapping

| Model | Fields / relationships | Required constraints |
|---|---|---|
| Cabinet | `name`, unique `slug`, required one-to-one `location → stock.StockLocation`, `width_units`, `height_units`, `revision`, `archived`, `active_mapping → MappingRevision` nullable, `default_profile → LocateProfile` nullable | Positive dimensions, both referenced mapping/profile belong to this cabinet. Location PROTECT, all cabinet associations PROTECT unless otherwise stated. |
| Drawer | `cabinet`, unique-per-cabinet `label`, `display_number`, required one-to-one `location`, `x,y,width,height`, `interior_width,interior_height`, `archived` | Unique `(cabinet,display_number)`; positive number/dimensions, nonnegative x/y; rectangle inside cabinet and nonoverlapping peers; location direct child of cabinet location and structural. |
| Bin | `drawer`, unique-per-drawer `label`, `x,y,width,height`, nullable one-to-one `location`, `archived` | Rectangle inside drawer interior and nonoverlapping peer bins; bound location direct child of drawer location, non-structural and not external. No per-bin LED override in v1. |
| DrawerAllocation | one-to-one `drawer`, `logical_start`, `logical_end` | Both positive, end ≥ start, end ≤ active mapping N; no overlap with another active drawer allocation in cabinet. A drawer without allocation is valid unlit storage, clearly marked. |
| MappingRevision | `cabinet`, `number`, `state` = draft/published/superseded, `total_pixels`, `content_hash`, `source_revision` (the cabinet revision used to validate the proposal), immutable published `manifest` JSON | Unique `(cabinet,number)`; N positive for published maps; manifest freezes output/string identities and address-affecting values. Published rows immutable. Empty cabinet may have no map (N=0 in computed summary). |
| PixelSpan | `mapping_revision`, `string`, `logical_start`, `length`, `string_offset`, `direction` (+1 or −1) | Unique `(mapping_revision,logical_start)`; positive start/length, nonnegative offset; same cabinet; physical slice in string bounds; logical coverage exactly `1..N`, physical slices nonoverlapping. `string_offset` is the lowest addressed local index; reverse changes traversal, not interval membership. |

Geometry uses integer grid units (default 1 mm; a cabinet's unit label is presentation, not an automatic conversion). Front view: origin top-left, x right, y down. Drawer bin canvas is a separate top-down plane; its dimensions need not equal the cabinet front rectangle. Half-open rectangles `[x,x+w) × [y,y+h)` allow touching edges, reject positive-area overlap; rotation is out of v1 scope. No responsive reflow changes saved coordinates.

Initial setup order is geometry/native bindings → electrical proposal → published complete map → drawer allocations. Without an active map, save unlit drawers but no allocation rows; the allocation editor explains this prerequisite. A mapping-publish request may include explicit replacement allocations so a shrink/remap and affected allocations validate atomically against the candidate N.

Logical display numbering is stored, not recalculated after a drag. An explicit **Renumber** preview sorts by `(y,x,id)` (row-major top-to-bottom, left-to-right); operator can override numbers for irregular layouts. It changes neither labels, native location names nor LED ranges. A single allocation row deliberately enforces the current contiguous-range requirement.

### 4.2 Electrical topology

| Model | Fields / relationships | Required constraints |
|---|---|---|
| Controller | `cabinet`, `name`, canonical `origin` (scheme/host/port only), `expected_mac` nullable until commissioned, `firmware_adapter`, `enabled`, `approved_snapshot → ConfigObservation` nullable, `desired_revision`, `status`, `last_seen`, `armed_until` nullable, `armed_by` nullable, `armed_mapping_hash`, `armed_config_hash`, `commissioning_policy` (bounded JSON: brightness cap, exclusive ownership, boot-off and transform/physical-calibration attestations) | Canonical origin unique; MAC unique when populated (normalise blank to null); cabinet reassignment allowed only through an explicit idle, unmapped decommission/recommission workflow; never shared concurrently. Draft controllers unlimited by schema; proposed operating policy max five per cabinet pending approval. Arm is bound to mapping/config hash and cleared on mutation/reboot/drift. |
| ControllerOutput | `controller`, `bus_index` (zero-based), `wled_start` (zero-based), `pixel_count`, `pins` ordered bounded JSON list of GPIO integers, `led_type`, `colour_order`, `bus_reverse`, `skip`, `auto_white_mode`, `max_current_ma` | Unique `(controller,bus_index)`; start ≥0, count >0; distinct legal GPIOs per supported bus and no conflicting output GPIO claims. Bus address intervals must not overlap. Imported output index is a snapshot position, not durable identity; ambiguous reorder requires manual matching. |
| LEDString | `output`, `label`, `output_offset` (zero-based WLED bus-address offset), `pixel_count`, `notes`, `archived` | Unique `(output,label)`; `output_offset` is the sole cable-order key (not label or database insertion order); nonoverlapping slices, offset+count ≤ output count. Default one string covers whole bus; multiple strings represent daisy-chained cable sections, not WLED segments or independently addressable GPIOs. Unused output slices are explicit in validation report. |
| ConfigObservation | `controller`, `observed_at`, `adapter_version`, whitelisted `info`, `normalised_config`, `fingerprint`, `capability_status`, `diff`, `observed_by` | Append-only; store only redacted necessary hardware/state fields, not whole `/json/cfg`, WiFi/OTA credentials, or browser-supplied URL. An observation is not automatically the approved configuration. |
| LocateProfile | `cabinet`, `name`, `purpose` (locate/test/reserved future), `rgb` (three bytes), `white` (byte, default 0), `brightness` (1..255), `duration_seconds` | Unique `(cabinet,name)`; recommended green locate, brightness 64 capped by commissioned controller policy, duration default 120 and hard max 120 seconds; tests default 5/max 10. Unsupported RGBW requests rejected, not silently remapped. |

`bus_reverse` and `skip` describe firmware's bus transform; PixelSpan.direction describes **application logical traversal**. Do not apply firmware reversal twice. V1 live support initially permits only digital 1D local RGB/RGBW buses with `bus_reverse=false`, `skip=0`, no custom ledmap/matrix/grouping/spacing/mirroring/segment offsets. Preserve unsupported observations as unsupported, allow simulated design, but block arm until an adapter with verified fixtures and calibration covers them. GPIO legality depends on the actual board/bus, not a universal ESP pin list. Do not infer output details from total LED count alone.

### 4.3 Operations and audit

| Model | Fields / relationships | Rules |
|---|---|---|
| LocateSession | `cabinet`, `actor` nullable SET_NULL, `target_kind`, nullable target `StockItem`/`StockLocation` SET_NULL, immutable target label/PK snapshot, `mode` simulate/live, `mapping_hash`, `layout_revision`, `profile_snapshot`, `idempotency_key`, `request_hash`, `state`, `expires_at`, `plan` JSON, `failure` JSON | Unique `(cabinet,idempotency_key)`; session states queued/preflight/applying/active/stopping/stopped/expired/failed/unknown; no live retry after expiry. Target is resolved again immediately before execution. |
| CabinetOperation | one-to-one `cabinet`, nullable `current_session`, `generation` integer, `lease_owner`, `lease_expires_at`, `heartbeat_at` | Precreate one row per cabinet. All state transitions use transaction + conditional revision/generation update. Unknown/uncleared session keeps reservation; elapsed lease alone never authorises a new operator to send. |
| ControllerExecution | `session`, `controller`, `generation`, `state`, `last_step`, `acknowledged_at`, `clear_status`, `error` | Unique `(session,controller)`; per-controller progress records partial failure and ambiguous acknowledgements. No success claim based only on task submission. |
| HardwareReadJob | `cabinet` nullable for discovery, `actor` nullable SET_NULL, `kind` discovery/observe/arm-preflight, `controller` nullable, `mode`, `scope_snapshot`, `q_task_id`, `state`, `result` (bounded redacted JSON), `error`, `expires_at` | Owns actor-scoped status/result and read authorisation; task ID alone confers no access. Durable job is created before enqueue with on-commit dispatch; enqueue failure is persisted. |
| DesignAudit | `cabinet` nullable, `actor` nullable, `operation`, `before_revision`, `after_revision`, `correlation_id`, bounded redacted `details`, `created_at` | Append-only for imports/publish/binding/arm/locate/stop/failure; proposed retention 90 days, configurable. Not a replacement for StockItemTracking. |

Cabinet/profile cycles are created with nullable pointers then validated when set. All structural FKs use PROTECT; deletion is archive-first with explicit validated purge of unreferenced drafts. Audit snapshots survive user/target deletion. Published mapping manifest is sufficient to diagnose old sessions even if draft topology later changes; topology in an active/published mapping cannot be destructively edited in place. To replace it, build and publish a complete new mapping/config proposal while idle.

### 4.4 Constraints, transactions and migration plan

DB `CheckConstraint`s enforce row-local numeric bounds, enums/direction and end≥start; `UniqueConstraint`s enforce the keys above. Cross-row/cross-model geometry, intervals, hierarchy, uniqueness of native location identity across cabinet/drawer/bin roles, and full coverage are service validations, not invented SQL CHECK subqueries. Use one authoritative validation module from serializers, `clean()` and command execution. Do not rely on `save()` implicitly calling `full_clean()`.

Define custom permissions in `Cabinet.Meta.permissions` as `configure_hardware`, `operate_hardware`, `emergency_stop`; use fully qualified `storage_layout.<codename>` checks plus built-in view/change permissions. Migration/post-migrate permission creation must not grant groups rights by default.

All layout, binding, electrical proposal and mapping writes go through cabinet aggregate transactions. Check `If-Match` revision and perform conditional `UPDATE ... WHERE revision=expected`; exactly one winner, increment once; rollback all on error. Use row locks where available, but SQLite correctness must also follow from compare-and-swap and unique constraints; retry DB busy failures boundedly. Native location creates/edits use native validation/permissions and remain separate explicit operations. Recheck ancestry/structural flags before publishing and live use; stale native-tree edits quarantine locating rather than auto-fix.

Migrations are additive in the plugin: 0001 storage/electrical schema, 0002 mapping and constraints, 0003 operational/audit/permission schema and reversible data creation for operation rows. Generate actual numbering/dependencies during implementation; initial stock dependency at this baseline is `('stock','0128_remove_stockitem_notes')`, user dependency is swappable. Do not modify core migrations. Avoid PostgreSQL-only exclusion constraints, partial-unique reliance or vendor-specific JSON queries. Test nullable uniqueness on all supported databases.

Deploy plugin package/assets and enable required gates; stop hardware service, back up database, register app, run `invoke migrate`, restart web and workers, verify schema/permissions/UI. New groups receive no operate rights automatically. Disable plugin without dropping its tables. Rollback package only if schema-compatible; do not reverse destructive migrations or delete native locations as rollback. No WLEDger import in these migrations.

## 5. REST API contract

Proposed base **`/plugin/storage-layout/api/v1/`**, mounted through UrlsMixin; trailing slashes required. Use DRF views/serializers, host authentication classes, explicit permission classes and drf-spectacular schema. Serve schema at `schema/` within this base if custom routes are not included in the host schema generator. SPA routes and API routes are distinct namespaces even though both contain `plugin`.

All controller-network actions are POST, never GET side effects. Read-only GETs return saved data only. JSON numbers are integers, UUIDs strings. Lists use paginated `{count,next,previous,results}` and cabinet/status filters. Detail/layout GETs include `ETag: "<revision>"`; aggregate mutations require `If-Match` (428 if absent, 412 if stale), including drawer layout, electrical PUT, profiles, import/approval/publish and arm. Cabinet creation has no prior ETag; observe/discovery/session creation use captured revision/hash and idempotency as specified; safety stop/disarm bypass stale-ETag rejection. No blind last-write-wins.

| Method and relative path | Request / response and semantics |
|---|---|
| GET/POST `cabinets/`; GET/PATCH `cabinets/{id}/` | Create/update cabinet root, native location reference and dimensions; no implicit native location creation. Return 201/200 with revision. DELETE is not exposed; archive via PATCH after dependency checks. |
| GET `cabinets/{id}/layout/` | Full geometry, allocations, native bindings, active map summary and validation diagnostics; N and numbering bases explicitly labelled. |
| POST `cabinets/{id}/validate-layout/` | Proposed complete aggregate document; same validation as save, returns errors/warnings/unused ranges, no persistence/no I/O. |
| PUT `cabinets/{id}/layout/` | Atomic cabinet + drawers + bins + allocations document; omission is not deletion unless UUID listed in `archive_ids`. Reject unknown/cross-cabinet IDs. Client-generated UUIDs allow references between new drawer/bin rows. Return canonical layout and new revision. |
| GET `drawers/{id}/layout/`; PUT `drawers/{id}/layout/` | Drawer-focused projection/save of interior/bin geometry; same cabinet ETag and transaction, not a separate conflicting revision. No physical drawer reparent in this endpoint. |
| GET `cabinets/{id}/electrical/`; PUT same | Saved controllers/outputs/strings and draft spans; changing saved desired topology is database-only. Requires idle cabinet; approved/live mappings remain immutable until explicit replacement. |
| POST `cabinets/{id}/mapping-preview/` | Candidate spans/N → validation, drawer impacts, deterministic mapping hash and sample translation. Never assign starts implicitly. |
| POST `cabinets/{id}/mapping-publish/` | Candidate hash + complete draft + optional explicit replacement drawer allocations + expected observation fingerprints → immutable revision and atomic active pointer. Reject uncovered logical pixels, collisions or invalid existing allocations. Explicitly lists changed physical pixels; no HTTP. |
| POST `translate/` | `{cabinet,logical_start,logical_end,mapping_hash}` → ordered split physical runs; simulate/read permission. Reject stale hash. |
| POST `discovery/` | Explicit operator action, approved allowlisted scope/method and `mode`; return job ID. Simulation uses fixtures. No autonomous scan on load. |
| POST `controllers/{id}/observe/` | Explicit read grant → job reads info/config/state, stores observation+diff. Returns 202. Never changes desired configuration or outputs. |
| POST `controllers/{id}/import-preview/` | Saved observation ID → proposed database-only electrical diff and mapping impacts; no hardware call. |
| POST `controllers/{id}/import/` | Observation ID, accepted diff hash, output/string identity matches, expected cabinet revision → apply proposal while idle; no logical compaction and no WLED write. Unsupported/missing fields block approval. |
| POST `controllers/{id}/approve-configuration/` | Saved observation fingerprint + mapping hash + declared commissioning checks; marks compatible expected config, still does not arm. |
| POST `cabinets/{id}/arm/`; POST `…/disarm/` | Operator approval for listed controllers/hash, bounded `armed_until` (recommended 15 minutes). Arm performs explicit preflight reads under the supplied read grant. Disarm also requests stop if necessary. No default persistent approval. |
| GET/POST `profiles/`; GET/PATCH `profiles/{id}/` | View/configure cabinet colour/brightness/duration; operation snapshots freeze values per session. |
| POST `locate-sessions/` | Exactly one target `{item|location|drawer}`, `cabinet`, `profile`, `mode`, expected mapping hash, `duration_seconds`, `idempotency_key`; live also `approve_live:true`. Authorise first; return 202 `{id,state,status_url,expires_at}`. Reject busy (409); same key/body returns same session, changed body 409. |
| GET `locate-sessions/{id}/`; GET list | Persisted status, per-controller acknowledgements, plan and simulation preview; not an assertion LEDs were visibly observed. |
| POST `locate-sessions/{id}/stop/`; POST `cabinets/{id}/stop/` | Idempotent owner/operator stop or elevated cabinet emergency stop; returns 202 until clear confirmed. Stop uses stored plan/ownership, not newly edited mappings. |
| POST `cabinets/{id}/pixel-tests/` | Operator-approved range/single pixel/walk, test-purpose profile ID, mode and mapping hash; same session/reservation protocol, strict low brightness/test duration. No unsupervised infinite animation. |
| GET `jobs/{id}/` | Authorised saved progress/result for observation/discovery operations. Use HardwareReadJob tied to existing Q task IDs for redacted durable progress/results, not a second task scheduler. |

Example layout payload after publishing a mapping (UUID values represented symbolically here, not literal valid requests). Cabinet location is assigned through cabinet creation/detail, not this geometry projection. Drawer interior height is depth in the top-down plane, not the front-face height:

```json
{
  "schema_version": 1,
  "cabinet": {"width_units": 600, "height_units": 800},
  "drawers": [{"id": "drawer-uuid", "label": "A1", "display_number": 1,
    "location": 41, "x": 0, "y": 0, "width": 300, "height": 100,
    "interior_width": 280, "interior_height": 400,
    "allocation": {"logical_start": 45, "logical_end": 75}}],
  "bins": [{"id": "bin-uuid", "drawer": "drawer-uuid", "label": "A1-01",
    "location": 42, "x": 0, "y": 0, "width": 70, "height": 100}],
  "archive_ids": []
}
```

Errors use `{code,message,errors:[{path,code,message,related_ids}],warnings,correlation_id}`. Codes include `geometry_overlap`, `binding_invalid`, `mapping_gap`, `physical_overlap`, `allocation_overlap`, `config_drift`, `unsupported_configuration`, `not_armed`, `cabinet_busy`, `controller_timeout`, `clear_unconfirmed`. HTTP: 400 malformed/domain-invalid, 401 unauthenticated where supported by host auth (session auth may return 403), 403 forbidden, 404 invisible/missing object, 409 busy/drift/unsafe state, 412 stale, 428 missing precondition, 429 rate limit, 503 task/transport unavailable. Asynchronous failures live in session/job status, not retroactively in the 202 response.

## 6. Cabinet designer

Full-page plugin route `cabinets/:id/design` (resolved under the plugin/SPA base), launched from plugin navigation/list or native cabinet-location panel. Three panes: drawer palette/list, SVG front-view canvas, property/validation inspector. Toolbar: select, add drawer, duplicate, delete/archive, snap grid, zoom/pan, fit, undo/redo, renumber preview, validate, save/revert. Simulation preview is visibly separate from live actions.

- Add via drag or numeric form; names, display number, native location, front rectangle, interior dimensions and logical start/end are editable in inspector. Draw allocation bands and labels including LED count (`end-start+1`), string/controller boundaries and unallocated portions. Never infer LED count from drawer width.
- Pointer capture allows move/resize with snap and bounds previews; invalid candidate is drawn red and cannot be committed/saved. Multi-select translations are one command and preserve offsets. Duplicate copies geometry/style only: new UUID/number, no location or LED allocation until explicitly assigned.
- Native location picker shows path/ownership and binding conflicts; link to host create/edit form. No silent stock moves/location reparenting. A drawer's physical number remains stable after dragging.
- Keyboard equivalent: focusable drawer list, arrow move by one grid unit, modified step, numeric rectangle/range form, Escape cancel, Enter commit. Buttons have accessible names and non-colour-only diagnostics. Touch handles have practical hit areas and canvas gestures do not swallow form scrolling.
- Show errors on affected rectangles and a linked error list; range overlap links both drawers. Report mapping holes as blocking and unused allocated-capable LEDs as warnings. Offline hardware is not a layout-save error; geometrically valid drawers with a native structural location can be saved unlit; only bins may be saved unbound.
- Resize cabinet smaller previews affected drawers; no auto-shrink/auto-reflow. Archive drawer requires acknowledgement of bins/native-location consequences, does not delete native location or stock, and releases its allocation only in the reviewed save.

## 7. Drawer/bin designer and client state

Drawer route `drawers/:id/design`, breadcrumb cabinet → drawer, top-down canvas using the drawer's interior dimensions. Same select/add/duplicate/move/resize/grid/keyboard/validation tools; bin inspector has label, rectangle, native location, native stock summary link and **inherited drawer LED range read-only**. Selecting any bin in simulation highlights the same drawer LEDs. Bin-level override and rotation are deliberately not implemented.

Create rows/columns with a previewable grid generator (counts/sizes/gutters); do not overwrite manually placed bins. Duplicate does not duplicate a location binding. Unbound bins display a warning and cannot be used as inventory targets. Deleting/archiving a bin removes only the overlay after confirmation, never its location/contents. Drawer interior resizing cannot clip bins. A binding's stock count is informational, not a cached plugin quantity.

Shared state model: normalised entities keyed by UUID; server snapshot + editable draft + selection/viewport + command history. Use public plugin context API/queryClient for server state and a plugin-local reducer/store for drafts, not host-internal stores. SVG Pointer Events require no new canvas dependency. Transform screen→canvas coordinates through viewport inverse; persist only integer units, not zoom or screen pixels.

Undo/redo stores semantic commands (`add`, `move`, `resize`, `bind`, `allocate`, `archive`, `batch`), coalescing a drag into one entry; cap history at 100 commands. It reverses local drafts only, never stock edits or hardware actions. New edit clears redo. Save is explicit; no autosave to server. Successful save replaces baseline, clears history and invalidates relevant queries. Provide an optional local recovery draft keyed by user/cabinet/revision, without stock contents or controller secrets, expiring after seven days; logout removes it.

A 412 retains draft and presents reload/discard or a side-by-side comparison; no automatic geometry merge. Reapply nonconflicting edits against latest revision then validate/save explicitly. Network failure retains dirty state and allows retry with same expected revision. Navigation/unload warns while dirty; HTTP 403 switches to read-only without losing local exportable draft. Large layouts render lightweight rectangles and virtualise lists; initial test budget is 500 drawers/2,000 bins per cabinet, performance measured rather than assumed.

## 8. Logical numbering and physical translation

### Definitions

- `L`: cabinet logical pixel, **1..N**, inclusive public ranges.
- `s,n`: PixelSpan logical start and length; logical end `s+n-1`.
- `o`: span's lowest string-local offset (zero-based); `d`: direction ±1.
- `t`: LEDString.output_offset; `b`: ControllerOutput.wled_start.
- `W`: zero-based WLED **controller-global** pixel index. Different controllers restart their own address space. GPIO is metadata about a bus, not part of the JSON state pixel address.

For `k=L-s`, `0<=k<n`:

```text
string_local = o + (k if d == +1 else n - 1 - k)
output_local = t + string_local
W = b + output_local
address = (controller_id, output_id, string_id, string_local, W)
```

This is a WLED-address-space mapping, not a claim about diode position under firmware transforms. With v1 restrictions (`skip=0`, bus reverse off, identity ledmap), output-local index also identifies the physical diode from the string input. Future adapters must prove transforms rather than casually adding `skip` or reversing again.

For requested inclusive `[A,B]`, validate integers and `1<=A<=B<=N`; for each intersecting span in logical order compute `a=max(A,s)`, `z=min(B,s+n-1)`, evaluate `W(a),W(z)` and emit `{logical_start:a,logical_end:z,controller,output,string,wled_start:min(Wa,Wz),wled_stop:max(Wa,Wz)+1,direction}`. All same-colour contiguous reversed ranges may be sorted ascending for output; retain traversal direction for calibration/walk. Merge only same-controller adjacent WLED intervals with identical attributes after collision validation; never merge across controllers. Returned runs must cover exactly `B-A+1` pixels.

### Worked example (different lengths, multiple outputs/controllers)

| Controller/output/string | WLED bus start; string offset; length | Logical span | Translation |
|---|---|---|---|
| A/out0/S1 | 0; 0; 50 | 1–50 | L1→A:0; L50→A:49 |
| A/out1/S2 | 80; 0; 30 | 51–80 | L51→A:80; L80→A:109 |
| B/out0/S3 | 10; 0; 40 | 81–120 | L81→B:10; L120→B:49 |

Drawer `[45,90]` splits to A `[44,50)`, A `[80,110)`, B `[10,20)`; counts `6+30+10=46`. WLED address gaps 50–79 and B 0–9 are not cabinet logical gaps. If S2 span direction is −1, L51→109 and L80→80; the whole same-colour interval remains `[80,110)`. A requested subrange L51–55 becomes `[105,110)`.

Mapping publish sorts spans and asserts `first.start=1`, each `next.start=previous.end+1`, final end=N. Physical interval overlap is checked per controller-global space as well as per string. Drawer allocations may leave `[1,N]` pixels unused; warnings quantify them. Draft incomplete mapping can be saved but cannot publish/arm. Expanding/reordering a string never changes another span's logical start implicitly. Explicit remap previews affected drawer addresses and invalidates arming/calibration approvals. A shrink that strands existing allocations cannot publish until allocations are explicitly resolved in the same aggregate change.

## 9. WLED protocol investigation and supported configuration

Public references consulted 2026-10-17, with no controller access:

- [Official JSON API](https://kno.wled.ge/interfaces/json-api/): `/json/info`, `/json/state`, `/json/cfg`, `/json/nodes`; segment ranges, individual LED control, `frz`, nightlight and serial-request warning. <!-- codespell:ignore kno -->
- [Multi-strip](https://kno.wled.ge/features/multi-strip/) and [settings](https://kno.wled.ge/features/settings/): outputs share controller address space, custom starts and hardware preferences. <!-- codespell:ignore kno -->
- [Pinned v16.0.1 cfg.cpp](https://github.com/wled/WLED/blob/v16.0.1/wled00/cfg.cpp): `serializeConfig`/`deserializeConfig`; explicitly says its JSON schema is **not an official stable API**. `hw.led.ins[]` contains `start`, `len`, ordered `pin[]`, `type`, `order`, `rev`, `skip`, `rgbwm`, current limits; bus changes initialise hardware and may persist. There is no output field called `offset`.
- [Pinned v16.0.1 json.cpp](https://github.com/wled/WLED/blob/v16.0.1/wled00/json.cpp): individual LED handling/state serialisation; [bus_manager.h](https://github.com/wled/WLED/blob/v16.0.1/wled00/bus_manager.h) is the reference for future bus-transform adapters.

Proposed initial adapter target: official v16.0.1, 1D local digital RGB/RGBW, identity transform restrictions in §4.2. This is **a support target, not tested hardware compatibility**. Other firmware remains simulation/observation-only until fixture/source review and approved calibration qualify it. The public docs evolve; pin fixtures and adapter parser version. Do not hardcode the documentation's illustrative LED-count maximum as a universal board limit.

`/json/info` confirms identity/version, total count, max segments, capabilities, uptime/live mode; it does **not** enumerate outputs/GPIOs. `/json/cfg` is best-effort version-specific observation. Missing cfg, PIN lock, malformed data or unknown hardware type produces `unverified/unsupported`, never a fabricated bus list. A manual configuration proposal is allowed for simulation; live mode needs verifiable supported configuration. `/json/pins` is optional corroboration on supported firmware, not a replacement for bus mapping.

### Discovery, observation and explicit import

V1 always supports manually entering a controller origin; optional discovery is an explicit bounded operator job using configured mDNS/browser-independent network support or a registered controller's `/json/nodes`. Do not add a new discovery dependency until needed; no arbitrary subnet sweep. Findings are untrusted candidates, deduplicated by MAC/origin, never auto-created, armed or imported.

Observe reads info/cfg/state using an allowlisted origin and stores only normalised necessary fields. Compare fingerprints over identity, adapter/version, count, bus starts/lengths/GPIO/types/order/reverse/skip, matrix/ledmap ownership-relevant flags and supported state geometry; exclude uptime/signal/power telemetry. Report runtime state changes separately from hardware config drift. Read again before every live session. Count mismatch, identity replacement, reordering ambiguity, unsupported transform or changed fingerprint blocks live execution and clears arm. An approved output reorder must explicitly match identities, not trust array position.

Import preview shows added/removed/reordered outputs, GPIO/count changes, impacted strings/spans/drawers and old/new addresses. Import applies a desired **database proposal** only, with expected revision and accepted diff hash. Mapping publish/config approval are separate. **Update configuration means updating the application's saved configuration from an explicit observation**, not programming WLED. V1 exposes no POST `/json/cfg`, GPIO write, reboot, preset save or firmware update. If hardware programming is requested later, it needs a separate approved design; even `sv:false` cannot be assumed to remove all bus-reinitialisation/persistence side effects.

## 10. Locate execution, safety and concurrency

### 10.1 Approval and target resolution

Hardware disabled by default; simulator transport cannot open sockets. Later live commissioning requires owner authorisation outside this design, controller-exclusive ownership, expected MAC, compatible approved observation, no transform/remapping, no realtime stream/playlist/external control, safe configured power limits, and a black/off boot policy verified by an operator. Do not auto-change boot configuration. Application brightness cap does not replace WLED current limiting or electrical engineering.

Arm is temporary and bound to configuration+mapping hashes. Locate/Test requires authenticated operator permission, `approve_live:true`, matching revision/hash and unexpired arm. Approval authorises only this bounded operation plus its cleanup; retries/stop/recovery cleanup do not ask permission again. No live reads/writes were executed during this task.

For stock target, load native StockItem at execution and verify it is still in stock/current location. Resolve a directly bound bin → drawer, or drawer location → its drawer allocation. A descendant of a bound bin inherits the nearest mapped ancestor; directly mapped identity wins. Cabinet/ancestor targets are rejected as ambiguous unless explicit operator test selects pixels; never light a whole cabinet from accidental ancestor fallback. No mapped ancestor/allocation gives `not_locatable`. If target moved between approval and execution or mapping changed, fail stale rather than light the old drawer; no automatic follow-up. Location ownership/visibility and permission are rechecked by the worker under the initiating user's current rights.

### 10.2 State protocol

Use one transient controlled segment per controller, **not one segment per drawer**; avoids `maxseg` exhaustion. After exclusive preflight, segment 0 spans `[0,info.leds.count)` with group=1, spacing=0, reverse/mirror off, offset=0, fx=0, segment `on:true,bri:255`, black primary and white=0; disable/delete other segments explicitly under the approved exclusive-ownership policy. Runtime takeover is a visible hardware action within Locate, never editing. Every state command includes explicit segment IDs, `tt:0`, and suppresses UDP notification (`udpn.nn:true`); no toggles, presets or flash writes. Reject active sync/realtime/external ownership rather than attempting to overpower it.

Serial sequence per controller:

1. Read/validate info/cfg/state; reject drift, unsupported state, reboot or ownership conflict. Persist execution plan and watchdog deadline before output changes.
2. Establish black, canonical segment geometry while master is off, including explicit segment `on:true,bri:255`; verify geometry/state. Set and verify controller nightlight instant-off backup `nl.on:true,dur:ceil(duration_seconds/60),mode:0,tbri:0` **before master-on or any non-black write** (minimum 1, maximum 2 minutes under v1 policy). Persist its start time; never extend the watchdog on duplicate/retry. An adapter that cannot establish/verify this ordering must refuse live mode.
3. Send master `on:true,bri:<capped>` in its own acknowledged request; verify master and segment on/brightness and backup remain armed. Off→on may unfreeze, so do not combine it with `seg.i`. Clear canonical segment explicitly (black, fx=0, frz=false), then send individual LED intervals, e.g. `{"seg":[{"id":0,"i":[44,50,"00FF00",80,110,"00FF00"]}],"udpn":{"nn":true},"tt":0}`. `i` indices are **segment-relative**, so canonical segment start 0 makes them equal W. For a future nonzero segment start q, subtract q; stop remains exclusive. Individual LED writes freeze the segment and are not returned by GET state.
4. Serialize bounded chunks (≤256 colours and conservative ≤8 KiB encoded payload per call); await each acknowledgement. Do not send parallel requests to one WLED. Keep all chunks inside the same session/deadline. Every write uses fixed desired values, never toggle semantics.
5. Track precise plugin expiry from the original session deadline; stop sooner than the device backup for shorter sessions. Nightlight is a coarse, non-certified backup with **one-minute minimum**: a crashed 5-second test can remain lit for up to roughly one minute, and transport/device faults can prevent even that guarantee. Display this residual exposure before live tests. Other timeout policies need corresponding adapter verification.
6. Session becomes active only when all required controllers acknowledge. UI says command acknowledged, not optically verified. Simulation returns the same split plan without HTTP.

Fixture tests must enforce backup arming before master-on and the first non-black pixel; commissioning must verify firmware does not reset/disarm it during the sequence. A state read cannot prove the individual pixel framebuffer; optionally `/json/live` is build-dependent, never a required substitute for physical calibration.

### 10.3 Stop, failure and ownership

Stop/expiry: cancel further chunks, invalidate queued operations through generation check; send master off, explicitly clear/unfreeze canonical segment to black (`frz:false,fx:0,col:[[0,0,0,0]]`), disable nightlight after confirmed off, read back off/freeze/state. Do not unfreeze into an old nonblack effect. Record per-controller clear acknowledgment; only then release cabinet reservation. Stop is idempotent, uses original approved controller IDs, and remains permitted when mapping is quarantined. An operator can invoke emergency off for the cabinet's exclusively owned controllers; log it.

On partial multi-controller failure, stop every controller possibly touched, cancel remainder and mark failed/unknown with per-controller results. There is no atomic network transaction or simultaneous cross-controller illumination guarantee. If response times out after send, assume the write may have applied; do not mark failed-and-safe. Read state where useful, perform authorised cleanup, retain `unknown/clear_unconfirmed` and block new sessions until reconciliation/operator acknowledgement. An unreachable controller may remain lit until its backup timer/power state changes; never report a successful clear without acknowledgment.

HTTP defaults: connect 2 seconds, read 3 seconds, bounded operation budget, at most two bounded retries for GET and idempotent cleanup; illuminating writes are not blindly retried after ambiguity. Rate-limit locate/test per user/cabinet (proposed 10/minute) and observe/discovery separately. Stop bypasses ordinary locate rate limit. Use a bounded worker queue; reject unavailable queue with 503 instead of accepting an untracked live request.

A database cabinet reservation plus one designated hardware dispatcher process serialises controllers. Q tasks submit durable work; they must not each become independent HTTP owners. Use generation checks immediately before each send, a dispatcher heartbeat and watchdog/reconciliation sweep for expired sessions at least every five seconds. Restart aborts unfinished illumination and performs cleanup first; never replay active locate automatically. No DB lock/lease can fence a paused old process at WLED itself: **do not automatically fail over to a second dispatcher until the old process is confirmed terminated**. Deployment enforces a single hardware writer and shutdown cleanup; document this operational limitation. DB-only layout/simulation can use ordinary multiworker concurrency.

External WLED UIs, MQTT, buttons, playlists or other senders can still interfere; there is no WLED compare-and-swap ownership API. Dedicated isolated controllers and drift checks mitigate, not eliminate, this. Unexpected state/uptime triggers quarantine and controlled stop, not restoration. Restoration of arbitrary prior lighting is out of scope because frozen pixels are not reconstructible from GET state.

### 10.4 Calibration and simulation

Calibration wizard: show saved circuit/map and simulated logical→WLED addresses; explicit approved low-brightness first/last pixel test per string, then boundary pixels, then a bounded sequential walk. Operator confirms physical string input/orientation, output GPIO and drawer highlight, records confirmation in configuration approval audit. Wrong orientation is corrected by a **mapping proposal**, not guessed WLED programming. Any map/config change invalidates calibration/arming. Never infer physical placement from a successful HTTP response.

Simulation uses the exact production translator, session validation and state machine with injectable clock/fake transport; canvas previews colour, controller/run plan and expiry. Allow fixtures for offline, timeout, partial failure, stale config and unexpected reboot. Clearly badge SIMULATION; switching mode never executes a preview plan without a new live approval and current validation.

## 11. Permissions, authentication and security

Use host session/token authentication with CSRF for cookie requests and public context API client; do not expose controllers directly to browser or place credentials in JS/local drafts. Pure configuration/read and live-operate rights are separate. Define plugin Django permissions, explicit model fallback where needed and API policy:

| Capability | Required policy |
|---|---|
| View geometry/map/simulation | Active authenticated user, plugin `view_cabinet`, native view rights and applicable native location ownership checks; filter querysets before returning details. |
| Edit layout/bind | `change_cabinet` plus native view/change rights for referenced locations; creating/reparenting native locations separately uses native add/change rights. |
| Electrical profiles/import/publish | `configure_hardware` plus cabinet change; idle reservation; no live permission implied. |
| Observe/discover/arm/live locate/test | `operate_hardware` plus cabinet/native view, explicit scoped approval, environment enabled; discovery/config identity changes additionally require configure rights. |
| Stop own session | Initiating active operator or hardware operator; revoked/inactive actor cannot issue new actions. Cleanup continues as internal safety work even if actor revoked. |
| Emergency cabinet stop | `emergency_stop` or superuser, scoped to known cabinet, audit mandatory; never inferred from generic stock-read permission. |

Proposed administrative groups are Storage Viewer, Layout Editor, Hardware Configurator and Hardware Operator; membership is explicit, not automatically granted to all inventory readers. Hardware actions must reject read-only token contexts even where native `IsAuthenticatedOrReadScope` admits them. Permission backend and token scope handling are verified during implementation with real host auth tests, not assumed from UI state. Redact origins where policy requires, secrets and raw network errors; reject cross-cabinet IDs to prevent indirect object-reference leaks.

Hardware origin handling is an SSRF boundary even under the repository's trusted-network/plugin threat model. Operator-approved inventory VLAN CIDR/host+port allowlist; http/https only, no URL userinfo/query/fragment/custom path, no redirects, no environment proxy inheritance. Resolve/pin validated addresses per request; reject loopback, metadata endpoints, multicast, unspecified/link-local and any address outside configured hardware networks (including IPv6 variants). Private hardware addresses are allowed **only within that explicit allowlist**. DNS/discovery results never bypass checks. TLS verification stays on for HTTPS; optional gateway credential is a server-side secret reference, not presumed native WLED token auth. Bounded JSON size/depth, timeouts and logs prevent huge/untrusted responses. Store whitelisted hardware observations, not full cfg/network configuration.

## 12. Testing and validation strategy

All implementation tests run with fake transport/loopback fixtures, never lab devices; default test network policy rejects hardware networks. No new test dependencies required for basic exhaustive/property-style loops; add a property-testing library only if justified later.

| Layer | Required cases |
|---|---|
| Mapping pure unit/property | L=1/N; singleton; unequal strings; multiple outputs/controllers; nonzero bus/string offsets; reverse direction; exact boundary/crossing; given 46-pixel example; every published L resolves exactly once, reverse lookup roundtrip, no cross-controller merge; reject overlap/holes/out-of-bounds/overflow/zero/fractional input. |
| Database/services | Geometry containment/touching/overlap; drawer interior distinct from front; unique binding/number; native reparent/delete guard; orphan quarantine; bin changes leave allocation unchanged; occupied rebind warnings; archived dependencies; atomic rollback; CAS conflicts and missing operation row; published manifest immutability. |
| API/auth | Every endpoint role matrix, anonymous/read-only token/CSRF, cross-cabinet references, owner restrictions, 412/428, idempotency duplicate/body mismatch, busy, error schema, no network on GET/edit/import/publish; explicit observe separated from import. |
| WLED adapter fixtures | Pinned info/cfg/state, missing cfg/PIN/unknown firmware, bus reorder, duplicate GPIO, same count/different GPIO drift, unsupported rev/skip/ledmap/matrix, RGBW, segment-relative/exclusive ends, separate master-on and i, freeze/clear, payload limits, notification suppression, timer order. |
| State machine/fault injection | Simulated expiry/stop; concurrent users and cabinets; one session across multiple controllers; GET and ambiguous POST timeout; partial apply/clear; delayed old generation; process kill/restart; revoked actor/target moved; queue outage; expired arm; unknown state blocks new locate; no indefinite illumination claim on unreachable hardware. |
| Security | URL allowlist/DNS rebinding/redirect/IPv6/proxy rejection, response size/depth, credential redaction, rate limits and emergency stop availability. |
| Frontend Playwright | Plugin activation/routes/panels, create/resize/move and keyboard/touch, grid generation, numbering preview, ranges across controllers, bin inheritance, bind and native links, undo/redo, dirty navigation, recovery, 412 conflict and failed save, permission/read-only, simulation/live separation, accessible error list, no console errors. |
| Upgrade/portability | Fresh plugin install, enable/migrate/restart, deactivate/reactivate retaining data, migrate forward/back safe fixtures, existing native inventory untouched, stock 0128 dependency, PostgreSQL/MySQL-or-MariaDB/SQLite constraints and two-client write race. |

Implementation commands follow `CONTRIBUTING.md`: `invoke dev.test --keepdb --runtest=<actual plugin test module>` (resolve installed module then; placeholder is not a current executable command); migration suite `invoke dev.test --migrations` without keepdb; `invoke dev.schema`; Ruff on plugin Python; frontend TypeScript/build/Biome and Playwright in plugin/host integration harness. Existing `src/frontend/tests/pui_plugins.spec.ts` is the integration precedent. Update deployment/QA evidence with actual commands/results, not this proposed matrix.

**Validation performed for this design:** repository-relative reference check (all 42 existing full source/doc paths resolve; explicitly proposed plugin directory excluded), JSON example parsing, balanced fenced blocks, whitespace and register-state checks, executable arithmetic checks of the 120-pixel unique mapping, 46-pixel split and reversed boundary example, `git diff --check`, source/path/symbol audit against baseline, migration/version inspection, four independent research reports and lead reconciliation, public WLED API and pinned config-source review, manual cross-check of protocol/mapping examples and documentation/reference checks recorded with the local documentation commit. No application tests, schema generation or builds are claimed: no application code was changed. No dependencies installed, no controller accessed and no hardware compatibility/optical calibration asserted.

## 13. Implementation stages and parallel work packages

| Stage | Deliverable / dependency | Parallel ownership |
|---|---|---|
| 0 — owner gate | Approve §16 defaults, plugin slug/package and dedicated-controller safety boundary; design remains unimplemented until approval | Architect/owner; no feature coding before gate |
| 1 — foundation | App/URL/UI package lifecycle, additive models/migrations, permission policy, geometry/map validators and immutable DTO/OpenAPI contracts | Backend worker owns Python schema/services; contract review by lead |
| 2 — simulation API | Aggregate CAS APIs, deterministic translator, sessions/fake transport and audit, no live network | API worker after schema/contract freeze; separate test worker owns integration fixtures/tests |
| 3 — visual editors | SVG shared primitives, cabinet designer, drawer designer, local command history and host panels/navigation | Frontend worker(s) own disjoint shared editor/cabinet/drawer files; no backend edits |
| 4 — WLED adapter | Pinned parsers, config observation/import diff, bounded transport/security and serial dispatcher; simulator fault cases first | Hardware worker owns adapter/dispatcher only; requires session contract from stage 2 |
| 5 — integration/QA | Native location workflows, item resolution, auth matrix, races/portability, migration lifecycle and production plugin builds | QA worker with lead integration; no shared schema edits without coordination |
| 6 — commissioning gate | Explicit owner hardware authorisation, approved firmware/physical calibration, stop/crash/drift acceptance and documented rollback | Human operator; no autonomous hardware testing |

Stages 2/3 and adapter fixture research can proceed in parallel after contracts. First live release waits for stages 1–5 and human gate 6. WLEDger import/cutover remains project 006 and must not be bundled with initial plugin migration. Recheck extension contracts on every InvenTree upgrade; the inspected version is development, not a universal stable ABI.

## 14. Acceptance criteria

### Design deliverable (this task)

- [x] Existing architecture, migrations, API/UI/plugin limitations and tooling investigated against named revision.
- [x] Storage/electrical independence, explicit stable spans, inclusive logical numbering and exclusive WLED translation specified.
- [x] Database constraints, migration lifecycle, APIs, both designers, permission/error policies, safety/state machine and tests specified.
- [x] No application implementation, live controller access or unrelated file changes; register synchronised to UNDER REVIEW.
- [ ] Owner design approval (not implied by completion of investigation).

### Future implementation release gates (not completed here)

- [ ] Fresh install/upgrade demonstrates plugin-only operation without stock/core/router modifications and preserves native/WLEDger data.
- [ ] Multi-controller/multi-output different-length mapping example and all invariant/property tests pass on supported databases.
- [ ] Editors persist exact geometry, prevent invalid saves, retain drafts on conflict and support accessible keyboard undo/redo; bin edits never change drawer LEDs.
- [ ] Native inventory transfers/tracking/barcodes still work; correct current bin/drawer resolves without duplicating stock.
- [ ] Every non-hardware action, including save/import/publish, proves zero hardware requests; default environment is simulation-only.
- [ ] Unsupported/drifted/offline configurations fail visibly, retain saved logical identity and cannot arm; import requires explicit diff acceptance.
- [ ] Concurrency/timeout/crash/partial failure tests prove no stale task may start a new illuminate operation and no unconfirmed clear is reported safe.
- [ ] HTTP chunks are sequential, ranges/counts exact, lighting approval and permission matrix enforced, stop idempotent and audited.
- [ ] Explicit human commissioning validates actual first/last/string boundaries, brightness/current policy and black/off stop + backup timeout on approved firmware.

## 15. Implementation risks and mitigations

- **AppMixin lifecycle/development baseline:** supported but deeply integrated; pin package/host revisions, migration/disable/restart tests and backup-first deployment. No runtime auto-migration on a layout request.
- **Unstable cfg and invisible physical transforms:** versioned parser with conservative unsupported state and actual calibration; no inferred GPIO/skip arithmetic or silent remapping.
- **Native locate actor loss:** use actor-aware plugin API/actions, not an unauditable async native hook. Any future native integration requires explicit contract review.
- **Network cannot provide hard real-time/safe-off guarantees:** acknowledge partial/unknown outcomes, single writer, device backup timer and manual power-off procedure; plugin timeout is not safety-rated hardware interlock.
- **Location changes outside plugin:** FKs + validation guards + boundary revalidation; quarantine hierarchy drift. Geometry overlay removal does not remove inventory.
- **Concurrency across databases:** aggregate CAS avoids relying solely on row locks or exclusion constraints; hardware single-writer lifecycle tested separately from DB correctness.
- **Design grows into general WLED editor:** explicitly exclude firmware/config writing, arbitrary effects/shared ownership, disjoint drawer ranges and per-bin LEDs. Add only under subsequent approved design changes.

## 16. Remaining owner decisions

These are genuine product/deployment decisions, **not missing technical investigation**. Implementation uses the recommended defaults below **as unapproved proposed defaults**: they are encoded in the plugin (settings, constraints, validation and adapter policy) but must not be represented as owner-approved or historical agreements until the owner confirms them. Values that a deployment relies on must be set explicitly rather than assumed.

| ID | Decision / alternatives | Recommended default and effect |
|---|---|---|
| P1 | Earlier five-controller limit versus no artificial limit; controller shared across cabinets? | Dedicated one-cabinet controller, configurable operational maximum five; no schema limit. Shared controllers require cross-cabinet arbitration and are out of v1. |
| P2 | Timeout/brightness/colour policy | Green RGB `(0,255,0)`, brightness 64 capped by commissioning, 120-second default **and maximum**, test 5/max10 seconds; precise plugin expiry + device backup rounded up to whole minutes (maximum two, minimum one; residual exposure acknowledged for short tests). Other duration maxima need verified device backup strategy. |
| P3 | Dedicated black/off takeover versus restore/share existing lighting | Dedicated exclusive ownership, explicit transient segment takeover and black/off stop; no arbitrary restoration. If shared/restored lighting is essential, redesign ownership/framebuffer capture before live implementation. |
| P4 | Irregular numbering and multiple drawer ranges/bin overrides | Stable manually editable numbers, optional explicit `(y,x)` renumber preview; exactly one contiguous drawer range, bins inherit. Disjoint ranges/overrides deferred unless owner changes current requirement. |
| P5 | Native location representation/geometry convention | Required cabinet/drawer structural locations, optional unbound-bin drafts and direct-parent bound bins; integer physical units, top-left axes, separate drawer interior plane. Existing incompatible trees need explicit project 006 mapping, not automatic reparenting. |
| P6 | Live deployment capability and network/security | Default simulation, temporary arm (15 min), approved VLAN allowlist, single writer, initial v16.0.1 restricted adapter and human commissioning. Actual firmware/board/network are not available in this repository; unknown devices stay blocked. |
| P7 | Audit/recovery retention and scale | 90-day operational audit/session retention after cleanup with immutable published mappings retained; seven-day local drafts; initial performance fixture 500 drawers/2,000 bins. Confirm legal/storage/scale needs before deployment. |

## 17. Implementation status

**Overall:** the plugin package is implemented and locally tested for the pure-model, editor and simulation stages. Live hardware operation is deliberately **not enabled or commissioned**. Nothing in this repository has been run against a physical controller.

### Implemented

| Stage | State | Notes |
|---|---|---|
| 1 — foundation | Implemented | `AppMixin` package, plugin-owned models, additive migrations `0001`–`0003` (stock dependency `0128_remove_stockitem_notes`), custom permissions `configure_hardware`/`operate_hardware`/`emergency_stop` created without granting groups, `validation.py`, DRF API + plugin `schema/`. |
| 2 — simulation API | Implemented | Aggregate CAS (`If-Match`/`ETag`, 428/412), layout/electrical documents, mapping preview/publish, `translate/`, idempotent locate/test sessions and durable read jobs, simulator transport, append-only audit. |
| 3 — visual editors | Implemented | React/Vite cabinet and drawer/bin designers, command history, geometry/validation state. Host UI declared through `UserInterfaceMixin`: three routes, a navigation item, a **stock location panel that resolves cabinet/drawer/bin bindings**, and a **stock item locate panel** using the actor-safe session API. All user-visible strings are Lingui `t`-wrapped with extractable/compilable catalogs; async sessions and read jobs are polled. |
| 4 — WLED adapter | Implemented (simulation-verified) | Bounded adapter with pinned-address transport, SSRF allowlist, capability classification, nightlight backup ordering, chunked individual-LED writes; `observe`/`import-preview`/`import`/`approve-configuration`. No lab device is used by any test. |
| 5 — integration/QA | Local suites passed; release qualification incomplete | Backend/API/UI declaration, migration, unit and built-bundle browser suites run locally; the complete cross-database, process-crash and deployed host acceptance matrix remains unqualified. |
| 6 — commissioning gate | Not started | Requires explicit owner hardware authorisation, approved firmware and physical calibration. |

### Verification evidence

- **Frontend** (`src/plugins/storage_layout/frontend`): `npm test` — 63 unit tests across 10 files passed; `npm run typecheck` (`tsc --noEmit`) — clean; `npm run lint` (Biome) — clean; `npm run build` — clean (catalogs compiled, bundle emitted). The Playwright harness is now **run**: `npm run e2e` — 18 browser tests passed in Chromium against a socket-free in-memory fixture API (route/panel/navigation wiring, load, pointer drag + undo/redo, numeric edits, CAS save with `If-Match`, 412 conflict retaining the draft, server validation, bin grid that skips existing bins, drawer/bin and stock-item locate with async `queued -> active` polling, observe `pending -> complete` polling, mapping preview/publish, plus the 500/2,000 performance budgets).
- **Python**: `python -m compileall` of the plugin package — clean; `ruff check` under the repository configuration (migrations excluded per the pre-commit `exclude`) — clean.
- **Added during this review**: regression coverage for the mapping-span boundary check in `tests/test_validation.py` (a span on a string with a non-zero `output_offset` was previously mis-reported as overflowing its string — see the fixed defect below).
- **Python test suite (run)**: `manage.py test storage_layout.tests --keepdb --exclude-tag migration_test` — 425 tests passed; `manage.py test storage_layout.tests.test_migrations --tag migration_test` — 6 tests passed. These were worker results against a prepared SQLite environment. Lead review subsequently found this command depended on saved registry state. Reproducible tests now explicitly use `--settings=storage_layout.test_settings`; final lead results are recorded below, superseding bootstrap assumptions. Worker `manage.py check` and `manage.py spectacular --validate` runs passed.

### Defect fixed in this review

`validation.validate_mapping_spans` compared an **output-local** slice end against the **string-local** `LEDString.pixel_count`. Any published mapping whose string had `output_offset > 0` (i.e. more than one string on an output) was therefore falsely rejected as overflowing its string. The bound is now checked in string-local coordinates; the physical-overlap intervals continue to use output-local coordinates. Covered by new tests.

### Known limitations and open gaps

- **No hardware approval.** `ENABLE_HARDWARE` defaults off, the network allowlist defaults to deny-all, and arm/observe/locate/test fail closed. Human commissioning (stage 6) is outstanding; do not describe the plugin as live-capable.
- **Owner decisions unapproved.** §16 defaults are implemented as proposed defaults only.
- **Actor/ownership scoping (resolved).** Cabinet, drawer, controller and session endpoints now resolve native `StockLocation` ownership through the host's `StockLocation.check_ownership` (honouring `STOCK_OWNERSHIP_CONTROL` and the nearest ancestor owner); an unowned object is reported as missing rather than forbidden, so the endpoints cannot be used to probe for other operators' objects. Cabinet, profile and session lists are filtered to owned cabinets. `GET jobs/{id}/` is actor-scoped: only the initiating actor (or a hardware operator) may read a job, and only for a cabinet they own.
- **Publish response detail (resolved).** `mapping-publish/` now returns `changed_pixels` (bounded to 500 entries), `changed_count` and `changed_truncated`, enumerating the physical pixels whose controller/WLED address changed relative to the previous active mapping.
- **Durable dispatch and rate limiting (resolved).** Locate/test sessions and hardware read jobs are dispatched asynchronously on transaction commit via Django-Q2; an enqueue failure is persisted on the durable row and an unavailable queue returns 503. Locate/test and observe/discovery are rate limited to 10 requests per minute per user and target.
- **Test breadth.** The complete cross-database concurrency/upgrade and process-crash qualification matrix remains unmeasured; the full native InvenTree suite is not claimed green (earlier worker runs encountered optional dependency, export, translation and package-download failures). The two plugin-induced core test assumptions found in that run are fixed and pass targeted regression tests. The 500-drawer/2,000-bin browser performance budget **is** now measured (500 drawers: 276–302 ms to interactive; 2,000 bins: 346–359 ms; fresh Chromium, synthetic in-memory fixture). Frontend locales other than English are untranslated placeholders that fall back to the English source, and the browser suite runs in Chromium only.
- **Single hardware writer.** The operational single-dispatcher limitation (§10.3) is documented. The reconciliation watchdog now performs a live clear only when `DISPATCHER_ENABLED` is set; otherwise an expired live session is marked `unknown` with its cabinet reservation retained, so the watchdog never becomes an unconfirmed second hardware writer.

### Final lead review and reproducible validation

- Fixed host `plugin.registry._purge_plugin_modules` to retain registered Django model packages; purging them during rediscovery created duplicate model identities and invalid FK reverse accessors. App-plugin code upgrades require a process restart. A regression test proves model-class identity survives rediscovery.
- Core tests now distinguish externally permissioned app models from core ruleset coverage and calculate mixin-filter expectations from installed plugins. No permission exemptions were added.
- Task execution atomically claims queued sessions/read jobs; rechecks actor permission, ownership, cabinet reservation, expiry, aggregate revision, mapping and target allocation. Preflight failures persist as failed status instead of silently disappearing in a task exception.
- Cabinet reservation uses generation-based CAS. Live apply and clear hold a cabinet database write lock, including SQLite; clear reconstructs progress from the saved plan if a worker died before writing execution rows.
- Live output requires explicit dispatcher opt-in, a running worker, and a watchdog heartbeat no older than 15 seconds, checked again at execution. Shared cache and supervised single logical dispatcher remain deployment requirements, not claims of device-level fencing.
- Simulated observations no longer update physical `last_seen`/online status. Discovery reports bounded saved-origin candidates, visibly labelled simulated; live discovery requires explicit controller IDs and still passes adapter allowlist checks. Autonomous subnet/mDNS discovery is not implemented.
- Lead frontend rerun: 63 unit tests, 19 Chromium browser tests, typecheck, lint and production build passed. Latest synthetic harness: 500 drawers 265 ms; 2,000 bins 356 ms.
- Lead migration rerun: 6 forward/reverse lifecycle tests passed in a disposable SQLite test database.
- Wheel build passed; inspected archive contains the Vite manifest and 23 compiled frontend assets.
- Final lead backend run: **461 tests passed** (455 plugin tests plus six affected-core tests), using `manage.py test storage_layout.tests users.tests.RuleSetModelTest plugin.test_api.PluginDetailAPITest.test_plugin_filter_by_mixin --keepdb --exclude-tag migration_test --settings=storage_layout.test_settings` in the isolated `/tmp/inv-data` SQLite environment. UI bundle-to-host manifest resolution is included.
- `manage.py check` passed; `makemigrations storage_layout --check --dry-run` reported no changes. Plugin-only OpenAPI validation (`spectacular --validate --fail-on-warn --urlconf storage_layout.urls`) passed with zero warnings/errors and no unsecured/unscoped paths. The entire host schema is **not** claimed clean: its generator reports unrelated existing errors when run against the full URL configuration.
- Repository pre-commit hooks passed (format/lint, whitespace, YAML, template lint, spelling, secret scan and test assertion checks). Frontend Biome is run independently because the host hook targets only `src/frontend/`.
- Added bounded walking calibration (range/walk selector, ordered per-pixel frames, per-step confirmed clear, deadline enforcement), tested with an injected WLED emulator and a browser request-contract test. No physical hardware was used.
- Additional hardening: OAuth tokens must satisfy scope restrictions **and** Django plugin permissions; read-only tokens cannot operate hardware. Cabinet aggregates are hidden when child locations override ownership for another operator. Configurable audit retention runs daily and preserves evidence for unresolved cabinets.
- No PostgreSQL/MariaDB server or container runtime is installed in this environment; cross-database qualification cannot be asserted. No physical controller, existing WLEDger data, live database or production deployment was accessed.

### Remaining release qualification and owner defaults

- Physical commissioning is intentionally blocked by the owner's explicit safety boundary. No simulator acknowledgement is evidence of emitted light or electrical safety.
- Cross-database/process-crash acceptance and a real deployed-host browser acceptance pass remain release work. Current browser tests load the real compiled bundle against an in-memory API fixture; DRF and public host declaration/manifest contracts are tested separately.
- Automatic subnet/mDNS discovery is not implemented; only explicit bounded registered-origin discovery is supported. Single-pixel/range and bounded walking tests are implemented. Walking is capped at 32 logical pixels within the test-profile duration (maximum ten seconds), clears and confirms each physical step, and exposes explicit simulation frame/timing previews. It cannot run as an unbounded animation. Historical sessions are retained rather than automatically purged; audit records have configurable retention. Non-English catalogs remain untranslated. These limitations mean this is **not a claim that every sentence of the original specification has passed release acceptance**.

### Owner defaults still required for hardware deployment (unchanged from §16)

P1–P7 remain open; P2 (colour/brightness/duration), P3 (black/off takeover), P4 (numbering), P5 (native binding convention), P6 (live deployment/network) and P7 (retention/scale) all affect runtime behaviour once hardware is enabled.

## 18. Change log

- 2026-10-18: Integrated implementation committed locally on `master` as `a4b247a546358dc1f73fadca93f8ddaab10c7cad` (`feat: implement storage layout and WLED plugin`), 106 files changed. Final validation: 461 backend/affected-core tests, six migration lifecycle tests, 63 frontend unit tests, 19 Chromium browser tests; plugin-only strict schema validation, build/wheel manifest inspection and all pinned pre-commit hooks passed. No push, physical controller access, WLEDger changes or production deployment. An exploratory check with unpinned Ruff 0.17.1 `--preview` reports 13 additional style/docstring findings; the repository-pinned Ruff 0.15.12 checks pass. Cross-database, deployed-host and physical acceptance remain explicitly unclaimed.

- 2026-10-17: Original requirements draft recovered from earlier discussions.
- 2026-10-17: Completed source-verified plugin architecture investigation, WLED API research and implementation-ready design; moved to UNDER REVIEW, retained owner/hardware/implementation approval gates. No application features implemented.
- 2026-10-18: Independent implementation review. Recorded stage 1–4 completion (simulation-only), stage 5 partial and stage 6 not started; added the verification evidence and limitations above; fixed the `validate_mapping_spans` string-bound coordinate bug and added regression tests. Design approval and hardware authorisation remain outstanding.
- 2026-10-18: Backend API/services hardening. Durable asynchronous dispatch for locate/test sessions and read jobs via on-commit Django-Q2 (enqueue failure persisted; unavailable queue returns 503); per-user/per-cabinet rate limiting (10/min) for locate/test and observe/discovery; actor-scoped read jobs; native `StockLocation` ownership filtering for cabinets/drawers/bins/controllers/sessions; `mapping-publish/` enumerates changed physical pixels; bounded five-second reconciliation watchdog with live cleanup gated on `DISPATCHER_ENABLED`. Plugin suite: 425 tests pass; migration suite: 6 tests pass.
- 2026-10-18: Frontend completion pass. Added the plugin navigation item; rewrote the stock location panel to resolve **drawers and bins** (via an additive, ownership-filtered `locations/<pk>/binding/` lookup) and added a stock item locate panel using the actor-safe session API (never `LocateMixin`); implemented the async polling contract (sessions `queued -> active`, read jobs `pending -> complete`); surfaced `changed_pixels`/`changed_count` on mapping publish; wrapped every user-visible string in Lingui `t` with extractable/compilable catalogs and a host-compatible `PluginLocale` wrapper; and corrected the stock-item context assumption (`part_detail`, not `part_name`). Verified: 63 frontend unit tests, 18 Playwright browser tests in Chromium (socket-free fixture API), `tsc`/Biome clean, `npm run build` clean; measured 500 drawers 276–302 ms and 2,000 bins 346–359 ms. No commits.
