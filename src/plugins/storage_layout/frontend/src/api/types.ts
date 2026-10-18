/**
 * Wire-format types for the Storage Layout & WLED plugin REST API.
 *
 * These mirror the **actual** backend shapes:
 *
 * - Read models: `storage_layout/serializers.py`.
 * - Aggregate documents: `services.layout_document`, `drawer_layout_document`,
 *   `electrical_document`, `mapping_preview`, `publish_mapping`,
 *   `translate_range`, `session_status`, `cabinet_diagnostics`.
 *
 * Notably, the server's validation issues are returned as
 * `{path, code, message, related_ids}` **without** a `severity` field; severity
 * is implied by the `errors` / `warnings` array they appear in. The
 * {@link normaliseReport} helper fills that in.
 */

export const SCHEMA_VERSION = 1;

/* ------------------------------------------------------------------ */
/* Layout documents                                                    */
/* ------------------------------------------------------------------ */

/** Inclusive logical allocation for a single drawer. */
export interface AllocationInput {
  logical_start: number;
  logical_end: number;
}

/** A drawer row inside a layout document. */
export interface DrawerInput {
  id: string | null;
  label: string;
  display_number: number;
  location: number | null;
  x: number;
  y: number;
  width: number;
  height: number;
  interior_width: number;
  interior_height: number;
  archived: boolean;
  allocation: AllocationInput | null;
}

/** A bin row inside a layout document. */
export interface BinInput {
  id: string | null;
  drawer: string;
  label: string;
  location: number | null;
  x: number;
  y: number;
  width: number;
  height: number;
  archived: boolean;
}

export interface CabinetBlock {
  width_units?: number;
  height_units?: number;
}

/** A complete cabinet layout document accepted by `PUT .../layout/`. */
export interface LayoutDocument {
  schema_version: number;
  cabinet: CabinetBlock;
  drawers: DrawerInput[];
  bins: BinInput[];
  archive_ids: string[];
}

/** Drawer-focused layout document accepted by `PUT drawers/{id}/layout/`. */
export interface DrawerLayoutDocument {
  schema_version: number;
  drawer: DrawerInput;
  bins: BinInput[];
  archive_ids: string[];
}

/* ------------------------------------------------------------------ */
/* Read models                                                         */
/* ------------------------------------------------------------------ */

export interface CabinetSummary {
  id: string;
  name: string;
  slug: string;
  location: number;
  width_units: number;
  height_units: number;
  revision: number;
  archived: boolean;
  /** Active mapping id (string) or null. */
  active_mapping: string | null;
  default_profile: string | null;
  created_at?: string;
  updated_at?: string;
  /** Optional native location path supplied by the API. */
  location_path?: string;
}

/** The `cabinet` block embedded in a layout document. */
export interface LayoutCabinetBlock {
  id: string;
  name?: string;
  slug?: string;
  revision: number;
  width_units: number;
  height_units: number;
  archived?: boolean;
  location?: number;
  active_mapping: string | null;
  mapping_hash?: string;
  total_pixels?: number;
  numbering_base?: number;
}

export interface MappingSummary {
  id: string;
  number: number;
  state: 'draft' | 'published' | 'superseded';
  total_pixels: number;
  content_hash: string;
  source_revision?: number;
}

export type DiagnosticSeverity = 'error' | 'warning';

/** A single server validation issue (`ValidationIssue.as_dict`). */
export interface RawIssue {
  path: string;
  code: string;
  message: string;
  related_ids: string[];
}

export interface Diagnostic {
  code: string;
  message: string;
  /** Injected by the client; absent on raw server issues. */
  severity: DiagnosticSeverity;
  path?: string;
  related_ids?: string[];
}

export interface UnusedRange {
  logical_start: number;
  logical_end: number;
}

export interface ValidationReport {
  errors: Diagnostic[];
  warnings: Diagnostic[];
  unused_ranges?: UnusedRange[];
}

/** Shape returned by `validate-layout`, `mapping-preview` and diagnostics. */
export interface RawValidationPayload {
  valid?: boolean;
  errors?: RawIssue[];
  warnings?: RawIssue[];
  unused_ranges?: number[][];
  total_pixels?: number;
  mapping_hash?: string;
  numbering_base?: number;
}

/** Attach the implied severity to raw server issues. */
export function normaliseIssues(
  issues: RawIssue[] | undefined,
  severity: DiagnosticSeverity
): Diagnostic[] {
  return (issues ?? []).map((issue) => ({
    code: issue.code,
    message: issue.message,
    path: issue.path,
    related_ids: issue.related_ids ?? [],
    severity
  }));
}

/** Convert a raw `{errors, warnings, unused_ranges}` payload into a report. */
export function normaliseReport(
  payload: RawValidationPayload | null | undefined
): ValidationReport {
  return {
    errors: normaliseIssues(payload?.errors, 'error'),
    warnings: normaliseIssues(payload?.warnings, 'warning'),
    unused_ranges: (payload?.unused_ranges ?? []).map((range) => ({
      logical_start: range[0],
      logical_end: range[1]
    }))
  };
}

export interface LayoutResponse {
  schema_version: number;
  cabinet: LayoutCabinetBlock;
  drawers: DrawerInput[];
  bins: BinInput[];
  archive_ids?: string[];
  /* Forward-compatible optional top-level projections. */
  active_mapping?: MappingSummary | null;
  total_pixels?: number;
  numbering_base?: number;
  validation?: RawValidationPayload;
  /** The layout GET attaches full diagnostics under `diagnostics`. */
  diagnostics?: RawValidationPayload;
}

export interface DrawerLayoutResponse {
  schema_version: number;
  cabinet: {
    id: string;
    revision: number;
    width_units?: number;
    height_units?: number;
    active_mapping: string | null;
    total_pixels: number;
  };
  drawer: DrawerInput;
  bins: BinInput[];
  archive_ids?: string[];
}

export interface LayoutValidationResponse extends RawValidationPayload {
  valid: boolean;
  errors: RawIssue[];
  warnings: RawIssue[];
  unused_ranges: number[][];
}

/** Derive `N` from a layout response regardless of which block carries it. */
export function layoutTotalPixels(response: LayoutResponse): number {
  return (
    response.total_pixels ??
    response.cabinet?.total_pixels ??
    response.diagnostics?.total_pixels ??
    0
  );
}

/** Derive the active-mapping summary from a layout response. */
export function layoutActiveMapping(
  response: LayoutResponse
): MappingSummary | null {
  if (response.active_mapping) return response.active_mapping;
  const id = response.cabinet?.active_mapping;
  if (!id) return null;
  return {
    id,
    number: 0,
    state: 'published',
    total_pixels: layoutTotalPixels(response),
    content_hash:
      response.cabinet?.mapping_hash ?? response.diagnostics?.mapping_hash ?? ''
  };
}

/* ------------------------------------------------------------------ */
/* Electrical topology                                                 */
/* ------------------------------------------------------------------ */

export interface StringInput {
  id: string | null;
  label: string;
  output_offset: number;
  pixel_count: number;
  notes?: string;
  archived: boolean;
}

export interface OutputInput {
  id: string | null;
  bus_index: number;
  wled_start: number;
  pixel_count: number;
  pins: number[];
  led_type: string;
  colour_order: string;
  bus_reverse: boolean;
  skip: number;
  auto_white_mode: number;
  max_current_ma: number | null;
  strings: StringInput[];
}

export interface ControllerInput {
  id: string | null;
  name: string;
  origin: string;
  expected_mac: string | null;
  firmware_adapter: string;
  enabled: boolean;
  commissioning_policy: Record<string, unknown>;
  outputs: OutputInput[];
  /* read-only projections */
  status?: string;
  last_seen?: string | null;
}

export interface ElectricalDocument {
  schema_version: number;
  controllers: ControllerInput[];
  archive_ids: string[];
}

export interface ElectricalResponse {
  schema_version: number;
  cabinet: {
    id: string;
    revision: number;
  };
  controllers: ControllerInput[];
  archive_ids?: string[];
}

/* ------------------------------------------------------------------ */
/* Mapping                                                             */
/* ------------------------------------------------------------------ */

export interface SpanInput {
  logical_start: number;
  length: number;
  string: string;
  string_offset: number;
  direction: 1 | -1;
}

export interface MappingCandidate {
  total_pixels: number;
  spans: SpanInput[];
}

export interface ReplacementAllocation {
  drawer: string;
  logical_start: number;
  logical_end: number;
}

export interface MappingPreviewResponse {
  valid: boolean;
  errors: Diagnostic[];
  warnings: Diagnostic[];
  unused_ranges: UnusedRange[];
  total_pixels: number;
  mapping_hash: string;
  samples: TranslationSample[];
  drawer_impacts: DrawerImpact[];
}

export interface DrawerImpact {
  drawer: string;
  label: string;
  logical_start: number;
  logical_end: number;
  runs: TranslationRun[];
  valid: boolean;
  error?: string;
}

export interface ChangedPixel {
  logical: number;
  before: [string, number] | null;
  after: [string, number] | null;
}

export interface MappingPublishResponse {
  id: string;
  number: number;
  state: string;
  total_pixels: number;
  mapping_hash: string;
  revision: number;
  /** Bounded list of physical pixels whose address changed. */
  changed_pixels?: ChangedPixel[];
  /** True total, so a truncated list is detectable. */
  changed_count?: number;
  changed_truncated?: boolean;
}

/* ------------------------------------------------------------------ */
/* Translation                                                         */
/* ------------------------------------------------------------------ */

export interface TranslationRun {
  logical_start: number;
  logical_end: number;
  controller: string;
  output: string;
  string: string;
  wled_start: number;
  wled_stop: number;
  direction: number;
}

export interface TranslationSample {
  logical: number;
  runs: TranslationRun[];
}

export interface TranslateResponse {
  mapping_hash: string;
  total_pixels: number;
  logical_start: number;
  logical_end: number;
  pixel_count: number;
  runs: TranslationRun[];
}

/* ------------------------------------------------------------------ */
/* Locate sessions, tests, jobs and profiles                           */
/* ------------------------------------------------------------------ */

export type LocateMode = 'simulate' | 'live';
export type TargetKind = 'item' | 'location' | 'drawer';

export interface LocateTarget {
  kind: TargetKind;
  id: string;
}

export interface LocateTargetInfo {
  kind: string;
  label: string;
  pk: string;
}

export interface LocateSessionCreate {
  cabinet: string;
  target: LocateTarget;
  profile?: string | null;
  mode: LocateMode;
  mapping_hash?: string;
  duration_seconds?: number;
  idempotency_key: string;
  approve_live: boolean;
}

export interface PixelTestCreate {
  pattern?: 'range' | 'walk';
  cabinet: string;
  logical_start: number;
  logical_end: number;
  profile?: string | null;
  mode: LocateMode;
  mapping_hash?: string;
  idempotency_key: string;
  approve_live: boolean;
}

export interface SessionExecution {
  controller: string;
  state: string;
  last_step?: string;
  clear_status?: string;
  acknowledged_at?: string | null;
  error?: Record<string, unknown> | string | null;
}

export interface ProfileSnapshot {
  id?: string;
  name: string;
  purpose: string;
  rgb: number[];
  white: number;
  brightness: number;
  duration_seconds: number;
}

export interface SessionPlan {
  pattern?: 'range' | 'walk';
  frames?: {
    logical_pixel: number;
    offset_seconds: number;
    runs: TranslationRun[];
  }[];
  mode: LocateMode;
  drawer?: string;
  drawer_label?: string;
  logical_start?: number;
  logical_end?: number;
  runs?: TranslationRun[];
  controllers?: string[];
  profile?: ProfileSnapshot;
  duration_seconds?: number;
  mapping_hash?: string;
}

export interface LocateSession {
  id: string;
  cabinet: string;
  state: string;
  mode: LocateMode;
  target: LocateTargetInfo;
  mapping_hash: string;
  layout_revision: number;
  profile?: ProfileSnapshot;
  plan?: SessionPlan;
  failure?: Record<string, unknown> | null;
  executions: SessionExecution[];
  expires_at: string;
  created_at: string;
  status_url?: string;
}

export interface HardwareReadJob {
  id: string;
  cabinet?: string | null;
  kind: string;
  controller?: string | null;
  state: string;
  mode: LocateMode;
  result?: Record<string, unknown> | null;
  error?: string | null;
  expires_at?: string | null;
  created_at?: string;
}

/** Read serializer shape for a locate profile. */
export interface LocateProfile {
  id: string;
  cabinet: string;
  name: string;
  purpose: 'locate' | 'test' | 'reserved';
  rgb: number[];
  white: number;
  brightness: number;
  duration_seconds: number;
}

/** Write payload accepted by `ProfileCreateSerializer`. */
export interface ProfileCreate {
  cabinet: string;
  name: string;
  purpose: 'locate' | 'test' | 'reserved';
  rgb_r: number;
  rgb_g: number;
  rgb_b: number;
  white: number;
  brightness: number;
  duration_seconds: number;
}

/* ------------------------------------------------------------------ */
/* Native location binding                                             */
/* ------------------------------------------------------------------ */

export interface LocationBindingCabinet {
  id: string;
  name: string;
  slug: string;
  revision: number;
  active_mapping: string | null;
  mapping_hash: string;
  total_pixels: number;
}

export interface LocationBindingDrawer {
  id: string;
  label: string;
  display_number: number;
  allocation: AllocationInput | null;
}

/** Result of resolving a native location to its plugin binding. */
export interface LocationBinding {
  location: number;
  bound: boolean;
  role: 'cabinet' | 'drawer' | 'bin' | null;
  cabinet: LocationBindingCabinet | null;
  drawer: LocationBindingDrawer | null;
  bin: { id: string; label: string } | null;
  /** True when the binding resolves to a drawer with an LED allocation. */
  locatable: boolean;
  /** Why the location is not locatable (`unbound`, `cabinet_root`, ...). */
  reason: string;
}

export interface ImportPreviewResult {
  observation: string;
  fingerprint: string;
  capability_status: string;
  diff_hash: string;
  added: unknown[];
  changed: unknown[];
  removed: string[];
}

export interface ArmRequest {
  controllers: string[];
  duration_minutes?: number;
}

export interface ArmResult {
  cabinet: string;
  armed_until: string;
  controllers: string[];
}

export interface DisarmResult {
  cabinet: string;
  armed_until: null;
}

export interface EmergencyStopResult {
  cabinet: string;
  stopped_session: string | null;
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export interface ErrorDetail {
  path?: string;
  code?: string;
  message?: string;
  related_ids?: string[];
}

export interface ApiErrorBody {
  code?: string;
  message?: string;
  errors?: ErrorDetail[];
  warnings?: Diagnostic[];
  correlation_id?: string;
  detail?: string;
}

/** A normalised API failure, thrown by the client. */
export class StorageLayoutApiError extends Error {
  code: string;
  status: number;
  details: ErrorDetail[];
  warnings: Diagnostic[];
  correlationId?: string;

  constructor(message: string, status: number, body: ApiErrorBody = {}) {
    super(message);
    this.name = 'StorageLayoutApiError';
    this.status = status;
    this.code = body.code ?? 'error';
    this.details = body.errors ?? [];
    this.warnings = body.warnings ?? [];
    this.correlationId = body.correlation_id;
  }

  get isStale(): boolean {
    return this.status === 412;
  }

  get isPreconditionRequired(): boolean {
    return this.status === 428;
  }

  get isBusy(): boolean {
    return this.status === 409;
  }

  get isForbidden(): boolean {
    return this.status === 403;
  }
}
