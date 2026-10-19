/**
 * Authenticated client for the Storage Layout plugin REST API.
 *
 * The client wraps the InvenTree axios instance supplied through the public
 * plugin context (`context.api`). It performs no network activity of its own:
 * every call is initiated by explicit user action.
 *
 * Concurrency: layout and electrical mutations are compare-and-swap. The
 * client records the `ETag` returned by the corresponding GET and sends it as
 * `If-Match` on writes, so a stale edit is rejected with HTTP 412 rather than
 * silently overwriting another operator's revision.
 *
 * Response normalisation: the server returns validation issues as
 * `{path, code, message, related_ids}` with no `severity`; the client attaches
 * `severity` from the containing `errors`/`warnings` array so the UI can render
 * them uniformly.
 */

import type { AxiosInstance, AxiosResponse } from 'axios';

import { Endpoints } from './endpoints';
import {
  type ArmRequest,
  type ArmResult,
  type CabinetSummary,
  type DisarmResult,
  type DrawerImpact,
  type DrawerLayoutDocument,
  type DrawerLayoutResponse,
  type ElectricalDocument,
  type ElectricalResponse,
  type EmergencyStopResult,
  type HardwareReadJob,
  type ImportPreviewResult,
  type LayoutDocument,
  type LayoutResponse,
  type LayoutValidationResponse,
  type LocateProfile,
  type LocateSession,
  type LocateSessionCreate,
  type LocationBinding,
  type MappingCandidate,
  type MappingPreviewResponse,
  type MappingPublishResponse,
  normaliseReport,
  type PixelTestCreate,
  type ProfileCreate,
  type RawIssue,
  type RawValidationPayload,
  type ReplacementAllocation,
  StorageLayoutApiError,
  type TranslateResponse,
  type TranslationSample
} from './types';

export interface ListResponse<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

export interface GetResult<T> {
  data: T;
  etag: string | null;
}

/** Extract a usable ETag from a response. */
export function readEtag(response: AxiosResponse): string | null {
  const header = response.headers?.etag ?? response.headers?.ETag;
  if (!header || typeof header !== 'string') {
    return null;
  }
  return header;
}

/** Convert an axios failure into a typed {@link StorageLayoutApiError}. */
export function normaliseError(error: unknown): StorageLayoutApiError {
  const axiosError = error as {
    response?: {
      status?: number;
      data?: unknown;
      headers?: Record<string, unknown>;
    };
    message?: string;
  };

  const response = axiosError?.response;

  if (!response) {
    return new StorageLayoutApiError(
      axiosError?.message ?? 'Network request failed',
      0
    );
  }

  const status = response.status ?? 0;
  const body =
    response.data && typeof response.data === 'object'
      ? (response.data as Record<string, unknown>)
      : {};

  const message =
    (typeof body.message === 'string' && body.message) ||
    (typeof body.detail === 'string' && body.detail) ||
    axiosError?.message ||
    `Request failed with status ${status}`;

  return new StorageLayoutApiError(message, status, body);
}

export function generateIdempotencyKey(): string {
  const cryptoObj = globalThis.crypto as Crypto | undefined;
  if (cryptoObj?.randomUUID) {
    return cryptoObj.randomUUID().replace(/-/g, '').slice(0, 32);
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

type RawMappingPreview = RawValidationPayload & {
  samples?: TranslationSample[];
  drawer_impacts?: DrawerImpact[];
};

export class StorageLayoutClient {
  private readonly api: AxiosInstance;

  constructor(api: AxiosInstance) {
    this.api = api;
  }

  private async get<T>(url: string): Promise<GetResult<T>> {
    try {
      const response = await this.api.get<T>(url);
      return { data: response.data, etag: readEtag(response) };
    } catch (error) {
      throw normaliseError(error);
    }
  }

  private async post<T>(
    url: string,
    body?: unknown,
    etag?: string | null
  ): Promise<T> {
    try {
      const headers: Record<string, string> = {};
      if (etag) headers['If-Match'] = etag;
      const response = await this.api.post<T>(url, body ?? {}, { headers });
      return response.data;
    } catch (error) {
      throw normaliseError(error);
    }
  }

  private async patch<T>(url: string, body: unknown): Promise<T> {
    try {
      const response = await this.api.patch<T>(url, body);
      return response.data;
    } catch (error) {
      throw normaliseError(error);
    }
  }

  private async put<T>(
    url: string,
    body: unknown,
    etag: string | null
  ): Promise<GetResult<T>> {
    try {
      const headers: Record<string, string> = {};
      if (etag) {
        headers['If-Match'] = etag;
      }
      const response = await this.api.put<T>(url, body, { headers });
      return { data: response.data, etag: readEtag(response) ?? etag };
    } catch (error) {
      throw normaliseError(error);
    }
  }

  /* ----------------------------- cabinets ---------------------------- */

  async listCabinets(_params: Record<string, unknown> = {}) {
    return this.get<ListResponse<CabinetSummary>>(Endpoints.cabinets()).then(
      (result) => result.data
    );
  }

  async getCabinet(id: string) {
    return this.get<CabinetSummary>(Endpoints.cabinet(id));
  }

  async createCabinet(body: {
    name: string;
    slug: string;
    location?: number;
    root_location_name?: string;
    width_units: number;
    height_units: number;
  }): Promise<CabinetSummary> {
    if (
      (body.location === undefined) ===
      (body.root_location_name === undefined)
    ) {
      throw new Error('Provide exactly one of location or root_location_name.');
    }
    return this.post<CabinetSummary>(Endpoints.cabinets(), body);
  }

  async updateCabinet(
    id: string,
    body: Partial<{
      name: string;
      width_units: number;
      height_units: number;
      archived: boolean;
      default_profile: string | null;
    }>
  ): Promise<CabinetSummary> {
    return this.patch<CabinetSummary>(Endpoints.cabinet(id), body);
  }

  /* ------------------------------ layout ----------------------------- */

  async getLayout(id: string) {
    return this.get<LayoutResponse>(Endpoints.cabinetLayout(id));
  }

  async validateLayout(
    id: string,
    document: LayoutDocument
  ): Promise<LayoutValidationResponse> {
    return this.post<LayoutValidationResponse>(
      Endpoints.cabinetValidateLayout(id),
      document
    );
  }

  async saveLayout(id: string, document: LayoutDocument, etag: string | null) {
    const withAutoCreatedLocations: LayoutDocument = {
      ...document,
      drawers: document.drawers.map((drawer) =>
        drawer.is_new && drawer.location === null
          ? { ...drawer, auto_create_location: true }
          : drawer
      ),
      bins: document.bins.map((bin) =>
        bin.is_new && bin.location === null
          ? { ...bin, auto_create_location: true }
          : bin
      )
    };
    return this.put<LayoutResponse>(
      Endpoints.cabinetLayout(id),
      withAutoCreatedLocations,
      etag
    );
  }

  async getDrawerLayout(id: string) {
    return this.get<DrawerLayoutResponse>(Endpoints.drawerLayout(id));
  }

  async getLocationBinding(
    locationId: number | string
  ): Promise<LocationBinding> {
    return (
      await this.get<LocationBinding>(Endpoints.locationBinding(locationId))
    ).data;
  }

  async saveDrawerLayout(
    id: string,
    document: DrawerLayoutDocument,
    etag: string | null
  ) {
    const withAutoCreatedLocations: DrawerLayoutDocument = {
      ...document,
      drawer:
        document.drawer.is_new && document.drawer.location === null
          ? { ...document.drawer, auto_create_location: true }
          : document.drawer,
      bins: document.bins.map((bin) =>
        bin.is_new && bin.location === null
          ? { ...bin, auto_create_location: true }
          : bin
      )
    };
    return this.put<DrawerLayoutResponse>(
      Endpoints.drawerLayout(id),
      withAutoCreatedLocations,
      etag
    );
  }

  /* ---------------------------- electrical --------------------------- */

  async getElectrical(id: string) {
    return this.get<ElectricalResponse>(Endpoints.cabinetElectrical(id));
  }

  async saveElectrical(
    id: string,
    document: ElectricalDocument,
    etag: string | null
  ) {
    return this.put<ElectricalResponse>(
      Endpoints.cabinetElectrical(id),
      document,
      etag
    );
  }

  /* ----------------------------- mapping ----------------------------- */

  async mappingPreview(
    id: string,
    candidate: MappingCandidate
  ): Promise<MappingPreviewResponse> {
    const raw = await this.post<RawMappingPreview>(
      Endpoints.cabinetMappingPreview(id),
      candidate
    );
    const report = normaliseReport(raw);
    return {
      valid: Boolean(raw.valid),
      errors: report.errors,
      warnings: report.warnings,
      unused_ranges: report.unused_ranges ?? [],
      total_pixels: raw.total_pixels ?? candidate.total_pixels,
      mapping_hash: raw.mapping_hash ?? '',
      samples: raw.samples ?? [],
      drawer_impacts: raw.drawer_impacts ?? []
    };
  }

  async mappingPublish(
    id: string,
    candidate: MappingCandidate & {
      expected_fingerprints?: Record<string, string>;
      replacement_allocations?: ReplacementAllocation[];
    },
    etag?: string | null
  ): Promise<MappingPublishResponse> {
    return this.post<MappingPublishResponse>(
      Endpoints.cabinetMappingPublish(id),
      candidate,
      etag
    );
  }

  async translate(body: {
    cabinet: string;
    logical_start: number;
    logical_end: number;
    mapping_hash?: string;
  }): Promise<TranslateResponse> {
    return this.post<TranslateResponse>(Endpoints.translate(), body);
  }

  /* ----------------------------- sessions ---------------------------- */

  async createLocateSession(body: LocateSessionCreate): Promise<LocateSession> {
    return this.post<LocateSession>(Endpoints.locateSessions(), {
      ...body,
      idempotency_key: body.idempotency_key || generateIdempotencyKey()
    });
  }

  async getLocateSession(id: string): Promise<LocateSession> {
    return (await this.get<LocateSession>(Endpoints.locateSession(id))).data;
  }

  async listLocateSessions(_params: Record<string, unknown> = {}) {
    return (
      await this.get<ListResponse<LocateSession>>(Endpoints.locateSessions())
    ).data;
  }

  async stopLocateSession(id: string) {
    return this.post<LocateSession>(Endpoints.locateSessionStop(id));
  }

  async stopCabinet(id: string): Promise<EmergencyStopResult> {
    return this.post<EmergencyStopResult>(Endpoints.cabinetStop(id));
  }

  async pixelTest(body: PixelTestCreate) {
    return this.post<LocateSession>(Endpoints.cabinetPixelTests(body.cabinet), {
      ...body,
      idempotency_key: body.idempotency_key || generateIdempotencyKey()
    });
  }

  /* ------------------------- hardware lifecycle ---------------------- */

  async armCabinet(id: string, body: ArmRequest): Promise<ArmResult> {
    return this.post<ArmResult>(Endpoints.cabinetArm(id), body);
  }

  async disarmCabinet(id: string): Promise<DisarmResult> {
    return this.post<DisarmResult>(Endpoints.cabinetDisarm(id));
  }

  async discovery(body: {
    cabinet?: string | null;
    mode: 'simulate' | 'live';
    scope?: Record<string, unknown>;
  }) {
    return this.post<HardwareReadJob>(Endpoints.discovery(), body);
  }

  async observeController(id: string, mode: 'simulate' | 'live' = 'simulate') {
    return this.post<HardwareReadJob>(Endpoints.controllerObserve(id), {
      mode
    });
  }

  async importPreview(
    controllerId: string,
    observation: string
  ): Promise<ImportPreviewResult> {
    return this.post<ImportPreviewResult>(
      Endpoints.controllerImportPreview(controllerId),
      { observation }
    );
  }

  async importConfiguration(
    controllerId: string,
    observation: string,
    acceptedDiffHash: string,
    etag?: string | null
  ) {
    return this.post<Record<string, unknown>>(
      Endpoints.controllerImport(controllerId),
      { observation, accepted_diff_hash: acceptedDiffHash },
      etag
    );
  }

  async approveConfiguration(
    controllerId: string,
    observation: string,
    mappingHash: string,
    checks: Record<string, unknown> = {}
  ) {
    return this.post<Record<string, unknown>>(
      Endpoints.controllerApprove(controllerId),
      { observation, mapping_hash: mappingHash, checks }
    );
  }

  async getJob(id: string) {
    return (await this.get<HardwareReadJob>(Endpoints.jobs(id))).data;
  }

  /* ----------------------------- profiles ---------------------------- */

  async listProfiles(cabinet?: string) {
    const url = cabinet
      ? `${Endpoints.profiles()}?cabinet=${encodeURIComponent(cabinet)}`
      : Endpoints.profiles();
    return (await this.get<ListResponse<LocateProfile>>(url)).data;
  }

  async createProfile(body: ProfileCreate) {
    return this.post<LocateProfile>(Endpoints.profiles(), body);
  }

  async updateProfile(id: string, body: Partial<ProfileCreate>) {
    return this.patch<LocateProfile>(Endpoints.profile(id), body);
  }
}

/** Re-export for consumers that only need the raw issue shape. */
export type { RawIssue };
