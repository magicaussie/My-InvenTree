/**
 * Layout editor state.
 *
 * Combines three concerns for both designers:
 *
 * 1. **Server state** (via the injected axios client and the plugin context's
 *    TanStack QueryClient) - loaded on mount, replaced on save/reload.
 * 2. **Editable draft** (a normalised {@link LayoutDraft}) plus a bounded
 *    {@link LayoutHistory} of semantic commands.
 * 3. **Session state** - selection, dirty flag, CAS revision, conflict and
 *    read-only status, and an optional local recovery draft.
 *
 * Saving is always explicit. A stale save (HTTP 412) keeps the draft and
 * surfaces a conflict; the draft is never merged automatically.
 */

import type { AxiosInstance } from 'axios';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { type GetResult, StorageLayoutClient } from '../api/client';
import {
  type LayoutCabinetBlock,
  type LayoutResponse,
  layoutActiveMapping,
  layoutTotalPixels,
  type MappingSummary,
  normaliseReport,
  StorageLayoutApiError,
  type ValidationReport
} from '../api/types';
import {
  type Command,
  draftFromResponse,
  emptyDraft,
  type LayoutDraft,
  LayoutHistory,
  layoutFromDraft
} from './commands';
import { type ClientValidation, validateDraft } from './validation';

const RECOVERY_PREFIX = 'storage_layout:draft:';
const RECOVERY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type EditorStatus = 'loading' | 'ready' | 'error' | 'readonly';

export interface RecoveryDraft {
  savedAt: number;
  draft: LayoutDraft;
}

interface StoredRecovery extends RecoveryDraft {
  revision: number | null;
}

export function recoveryKey(
  cabinetId: string,
  revision: number | null
): string {
  return `${RECOVERY_PREFIX}${cabinetId}:${revision ?? 'new'}`;
}

export function readRecovery(
  cabinetId: string,
  revision: number | null
): RecoveryDraft | null {
  try {
    const raw = globalThis.localStorage?.getItem(
      recoveryKey(cabinetId, revision)
    );
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredRecovery;
    if (!parsed?.draft || !parsed.savedAt) return null;
    if (Date.now() - parsed.savedAt > RECOVERY_TTL_MS) {
      globalThis.localStorage?.removeItem(recoveryKey(cabinetId, revision));
      return null;
    }
    return { savedAt: parsed.savedAt, draft: parsed.draft };
  } catch {
    return null;
  }
}

export function writeRecovery(
  cabinetId: string,
  revision: number | null,
  draft: LayoutDraft
): void {
  try {
    const payload: StoredRecovery = {
      savedAt: Date.now(),
      revision,
      draft
    };
    globalThis.localStorage?.setItem(
      recoveryKey(cabinetId, revision),
      JSON.stringify(payload)
    );
  } catch {
    /* storage unavailable - recovery is best effort */
  }
}

export function clearRecovery(
  cabinetId: string,
  revision: number | null
): void {
  try {
    globalThis.localStorage?.removeItem(recoveryKey(cabinetId, revision));
  } catch {
    /* ignore */
  }
}

export interface UseLayoutEditorOptions {
  /** InvenTree axios instance from the plugin context. */
  api: AxiosInstance;
  cabinetId: string;
  /** When true the editor loads but must not offer mutation actions. */
  readOnly?: boolean;
  /** Disable local recovery drafting (used by tests). */
  disableRecovery?: boolean;
}

export interface LayoutEditor {
  status: EditorStatus;
  draft: LayoutDraft;
  cabinet: LayoutCabinetBlock | null;
  revision: number | null;
  etag: string | null;
  totalPixels: number;
  activeMapping: MappingSummary | null;
  serverValidation: ValidationReport | null;
  validation: ClientValidation;
  selection: string[];
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  conflict: boolean;
  error: string | null;
  recovery: RecoveryDraft | null;
  saving: boolean;
  apply: (command: Command, coalesceKey?: string) => void;
  undo: () => void;
  redo: () => void;
  setSelection: (ids: string[]) => void;
  toggleSelection: (id: string, additive: boolean) => void;
  save: () => Promise<boolean>;
  refresh: () => Promise<void>;
  acceptBackgroundEtag: (etag: string | null) => void;
  revert: () => void;
  discardRecovery: () => void;
  acceptRecovery: () => void;
}

export function useLayoutEditor(options: UseLayoutEditorOptions): LayoutEditor {
  const { cabinetId } = options;
  const client = useMemo(
    () => new StorageLayoutClient(options.api),
    [options.api]
  );

  const historyRef = useRef<LayoutHistory>(new LayoutHistory(emptyDraft()));
  const [, forceRender] = useState(0);
  const rerender = useCallback(() => forceRender((v) => v + 1), []);

  const [status, setStatus] = useState<EditorStatus>('loading');
  const [cabinet, setCabinet] = useState<LayoutCabinetBlock | null>(null);
  const [revision, setRevision] = useState<number | null>(null);
  const [etag, setEtag] = useState<string | null>(null);
  const [totalPixels, setTotalPixels] = useState(0);
  const [activeMapping, setActiveMapping] = useState<MappingSummary | null>(
    null
  );
  const [serverValidation, setServerValidation] =
    useState<ValidationReport | null>(null);
  const [selection, setSelectionState] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<RecoveryDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const baselineRef = useRef<LayoutDraft | null>(null);

  const load = useCallback(
    async (adoptRecovery: boolean, silent = false) => {
      if (!silent) {
        setStatus('loading');
      }
      setError(null);
      try {
        const result: GetResult<LayoutResponse> =
          await client.getLayout(cabinetId);
        const response = result.data;
        const draft = draftFromResponse(response);
        historyRef.current = new LayoutHistory(draft);
        baselineRef.current = draft;
        setCabinet(response.cabinet);
        setRevision(response.cabinet.revision);
        setEtag(result.etag ?? `"${response.cabinet.revision}"`);
        setTotalPixels(layoutTotalPixels(response));
        setActiveMapping(layoutActiveMapping(response));
        setServerValidation(
          response.diagnostics
            ? normaliseReport(response.diagnostics)
            : response.validation
              ? normaliseReport(response.validation)
              : null
        );
        setDirty(false);
        setConflict(false);
        setStatus(options.readOnly ? 'readonly' : 'ready');

        if (!options.disableRecovery && !options.readOnly) {
          const stored = readRecovery(
            cabinetId,
            response.cabinet.revision ?? null
          );
          if (stored && adoptRecovery) {
            historyRef.current.present = stored.draft;
            setDirty(true);
          }
          setRecovery(stored);
        }
      } catch (err) {
        const apiError =
          err instanceof StorageLayoutApiError
            ? err
            : new StorageLayoutApiError(String(err), 0);
        if (apiError.isForbidden) {
          setStatus('readonly');
          setError(null);
        } else {
          setStatus('error');
          setError(apiError.message);
        }
      }
      rerender();
    },
    [cabinetId, client, options.readOnly, options.disableRecovery, rerender]
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  const draft = historyRef.current.present;

  const validation = useMemo(
    () => validateDraft(draft, totalPixels),
    [draft, totalPixels]
  );

  const apply = useCallback(
    (command: Command, coalesceKey?: string) => {
      if (status !== 'ready') return;
      historyRef.current.apply(command, coalesceKey);
      setDirty(true);
      setConflict(false);
      if (!options.disableRecovery && revision !== null) {
        writeRecovery(cabinetId, revision, historyRef.current.present);
      }
      rerender();
    },
    [status, cabinetId, revision, options.disableRecovery, rerender]
  );

  const undo = useCallback(() => {
    if (status !== 'ready') return;
    historyRef.current.undo();
    setDirty(true);
    rerender();
  }, [status, rerender]);

  const redo = useCallback(() => {
    if (status !== 'ready') return;
    historyRef.current.redo();
    setDirty(true);
    rerender();
  }, [status, rerender]);

  const setSelection = useCallback((ids: string[]) => {
    setSelectionState(ids);
  }, []);

  const toggleSelection = useCallback((id: string, additive: boolean) => {
    setSelectionState((current) => {
      if (!additive) {
        return current.length === 1 && current[0] === id ? [] : [id];
      }
      return current.includes(id)
        ? current.filter((value) => value !== id)
        : [...current, id];
    });
  }, []);

  const save = useCallback(async (): Promise<boolean> => {
    if (status !== 'ready') return false;
    setSaving(true);
    setError(null);
    try {
      const submittedDraft = historyRef.current.present;
      const document = layoutFromDraft(submittedDraft);
      const result = await client.saveLayout(cabinetId, document, etag);
      const response = result.data;
      const nextDraft = draftFromResponse(response);
      baselineRef.current = nextDraft;
      if (historyRef.current.present === submittedDraft) {
        historyRef.current.reset(nextDraft);
        setDirty(false);
      } else {
        // Keep edits made while the request was in flight; the next save uses
        // the revision returned here as its new compare-and-swap base.
        setDirty(true);
      }
      setCabinet(response.cabinet);
      setRevision(response.cabinet.revision);
      setEtag(result.etag ?? `"${response.cabinet.revision}"`);
      setTotalPixels(layoutTotalPixels(response));
      setActiveMapping(layoutActiveMapping(response));
      setServerValidation(
        response.diagnostics
          ? normaliseReport(response.diagnostics)
          : response.validation
            ? normaliseReport(response.validation)
            : null
      );
      setConflict(false);
      if (!options.disableRecovery) {
        clearRecovery(cabinetId, revision);
        if (historyRef.current.present === nextDraft) {
          setRecovery(null);
        } else {
          writeRecovery(
            cabinetId,
            response.cabinet.revision,
            historyRef.current.present
          );
        }
      }
      rerender();
      return true;
    } catch (err) {
      const apiError =
        err instanceof StorageLayoutApiError
          ? err
          : new StorageLayoutApiError(String(err), 0);
      if (apiError.isStale) {
        setConflict(true);
        setError(apiError.message);
      } else if (apiError.isForbidden) {
        setStatus('readonly');
      } else {
        setError(apiError.message);
      }
      return false;
    } finally {
      setSaving(false);
    }
  }, [
    status,
    cabinetId,
    etag,
    client,
    options.disableRecovery,
    revision,
    rerender
  ]);

  const refresh = useCallback(async () => {
    await load(false, true);
  }, [load]);

  const revert = useCallback(() => {
    if (baselineRef.current) {
      historyRef.current.reset(baselineRef.current);
      setDirty(false);
      setConflict(false);
      rerender();
    }
  }, [rerender]);

  const discardRecovery = useCallback(() => {
    clearRecovery(cabinetId, revision);
    setRecovery(null);
  }, [cabinetId, revision]);

  const acceptRecovery = useCallback(() => {
    if (recovery) {
      historyRef.current.present = recovery.draft;
      setDirty(true);
      setRecovery(null);
      rerender();
    }
  }, [recovery, rerender]);

  return {
    status,
    draft,
    cabinet,
    revision,
    etag,
    totalPixels,
    activeMapping,
    serverValidation,
    validation,
    selection,
    dirty,
    canUndo: historyRef.current.canUndo,
    canRedo: historyRef.current.canRedo,
    conflict,
    error,
    recovery,
    saving,
    apply,
    undo,
    redo,
    setSelection,
    toggleSelection,
    save,
    refresh,
    acceptBackgroundEtag: (value) => {
      if (value) {
        setEtag(value);
        setRevision(Number(value.replaceAll('"', '')));
      }
    },
    revert,
    discardRecovery,
    acceptRecovery
  };
}

/** Warn the browser before unload while the draft is dirty. */
export function useDirtyUnloadGuard(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
}
