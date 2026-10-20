import {
  Alert,
  Button,
  Checkbox,
  FileButton,
  Group,
  NumberInput,
  Stack,
  Text
} from '@mantine/core';
import type { AxiosInstance } from 'axios';
import { useEffect, useRef, useState } from 'react';
import { normaliseError, readEtag } from '../../api/client';
import { API_BASE } from '../../api/endpoints';
import { useDirtyUnloadGuard } from '../../state/layoutDraft';
import { EditorCanvas, type EditorCanvasProps } from './EditorCanvas';

export interface BackgroundMetadata {
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  visible: boolean;
  locked: boolean;
  aspect_locked: boolean;
}
interface Document {
  image_url: string | null;
  metadata: BackgroundMetadata;
}
interface Props extends EditorCanvasProps {
  api: AxiosInstance;
  target: 'cabinets' | 'drawers';
  targetId: string;
  layoutDirty: boolean;
  readOnly: boolean;
  rootEtag: string | null;
  onBackgroundSaved: (etag: string | null) => void;
}

/** Target-keyed lifetime prevents late responses from crossing editor identities. */
export function BackgroundCanvas(props: Props) {
  return (
    <BackgroundSession key={`${props.target}/${props.targetId}`} {...props} />
  );
}
function BackgroundSession(props: Props) {
  const {
    api,
    target,
    targetId,
    layoutDirty,
    readOnly,
    onBackgroundSaved,
    rootEtag,
    ...canvas
  } = props;
  const endpoint = `${API_BASE}${target}/${encodeURIComponent(targetId)}/background/`;
  const [document, setDocument] = useState<Document | null>(null);
  const [metadata, setMetadata] = useState<BackgroundMetadata | null>(null);
  const [etag, setEtag] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [aspect, setAspect] = useState(1);
  const [mode, setMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const past = useRef<BackgroundMetadata[]>([]);
  const future = useRef<BackgroundMetadata[]>([]);
  const alive = useRef(true);
  const [forbidden, setForbidden] = useState(false);
  const dirty =
    !!metadata &&
    JSON.stringify(metadata) !== JSON.stringify(document?.metadata);
  useDirtyUnloadGuard(dirty || busy);
  useEffect(() => {
    alive.current = true;
    setBusy(true);
    let cancelled = false;
    api
      .get<Document>(endpoint)
      .then(async (response) => {
        if (cancelled) return;
        setDocument(response.data);
        setMetadata(response.data.metadata);
        setEtag(readEtag(response));
        if (response.data.image_url) {
          // Never follow a server-provided URL to an arbitrary origin.
          const content = await api.get(`${endpoint}content/`, {
            responseType: 'blob'
          });
          if (cancelled) return;
          setUrl(URL.createObjectURL(content.data));
        }
      })
      .catch((failure) => {
        if (!cancelled) {
          const error = normaliseError(failure);
          setError(error.message);
          if (error.isForbidden) setForbidden(true);
        }
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      alive.current = false;
      cancelled = true;
    };
  }, [api, endpoint]);
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url]
  );
  useEffect(() => {
    if (!dirty && !busy && rootEtag) setEtag(rootEtag);
  }, [rootEtag, dirty, busy]);
  const requestBusy = useRef(false);
  const disabled = readOnly || forbidden || layoutDirty || busy || !document;
  const change = (patch: Partial<BackgroundMetadata>) => {
    if (!disabled && metadata) {
      const next = { ...metadata, ...patch };
      if (
        ![next.x, next.y, next.width, next.height, next.opacity].every(
          Number.isFinite
        ) ||
        next.width < 0.0001 ||
        next.height < 0.0001 ||
        next.width > 20 ||
        next.height > 20 ||
        Math.abs(next.x) > 10 ||
        Math.abs(next.y) > 10
      )
        return;
      past.current = [...past.current.slice(-99), metadata];
      future.current = [];
      setMetadata(next);
    }
  };
  const mutate = async (method: 'post' | 'patch' | 'delete', file?: File) => {
    if (disabled || !etag || requestBusy.current) return;
    if (
      file &&
      (file.size > 8 * 1024 * 1024 ||
        !['image/png', 'image/jpeg', 'image/webp'].includes(file.type))
    ) {
      setError('Choose PNG, JPEG or WebP, at most 8 MiB.');
      return;
    }
    requestBusy.current = true;
    setBusy(true);
    setError(null);
    const form = new FormData();
    if (file) form.append('image', file);
    try {
      const response = await api.request<Document>({
        url: endpoint,
        method,
        headers: {
          'If-Match': etag,
          ...(method === 'post' ? { 'Content-Type': undefined } : {})
        },
        data:
          method === 'post' ? form : method === 'patch' ? metadata : undefined
      });
      if (!alive.current) return;
      past.current = [];
      future.current = [];
      setDocument(response.data);
      setMetadata(response.data.metadata);
      setEtag(readEtag(response));
      onBackgroundSaved(readEtag(response));
      if (method !== 'patch') {
        setUrl(null);
        if (response.data.image_url) {
          const content = await api.get(`${endpoint}content/`, {
            responseType: 'blob'
          });
          if (alive.current) setUrl(URL.createObjectURL(content.data));
        }
      }
    } catch (failure) {
      if (alive.current) {
        const error = normaliseError(failure);
        setError(error.message);
        if (error.isForbidden) setForbidden(true);
      }
    } finally {
      requestBusy.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const bounds = canvas.bounds;
  const rect = metadata
    ? {
        x: metadata.x * bounds.width,
        y: metadata.y * bounds.height,
        width: metadata.width * bounds.width,
        height: metadata.height * bounds.height
      }
    : null;
  const editing = mode && !!rect && !!url && !metadata?.locked && !disabled;
  const image =
    metadata?.visible && url && rect ? (
      <image
        data-testid='background-image'
        href={url}
        {...rect}
        opacity={metadata.opacity}
        preserveAspectRatio={metadata.aspect_locked ? 'xMidYMid meet' : 'none'}
        onLoad={(event) => {
          // Decode intrinsic dimensions without attaching credentials to an img URL.
          const probe = new Image();
          probe.onload = () => {
            if (alive.current) setAspect(probe.width / probe.height);
          };
          probe.src = event.currentTarget.href.baseVal;
        }}
        onError={() => setError('Background image could not be loaded.')}
      />
    ) : null;
  return (
    <Stack
      gap='xs'
      data-background-editor={mode ? 'active' : undefined}
      onKeyDown={(event) => {
        if (mode) event.stopPropagation();
      }}
    >
      <Group wrap='wrap'>
        <Checkbox
          label='Edit background image'
          checked={mode}
          disabled={disabled || !url}
          onChange={(event) => setMode(event.currentTarget.checked)}
        />
        <FileButton
          accept='image/png,image/jpeg,image/webp'
          onChange={(file) => {
            if (file) void mutate('post', file);
          }}
        >
          {(buttonProps) => (
            <Button {...buttonProps} disabled={disabled || dirty}>
              {url ? 'Replace background' : 'Upload background'}
            </Button>
          )}
        </FileButton>
        <Button
          disabled={disabled || !document?.image_url}
          color='red'
          onClick={() => {
            if (
              window.confirm(
                'Remove this background reference? The stored image is retained.'
              )
            )
              void mutate('delete');
          }}
        >
          Remove background
        </Button>
        <Text size='xs'>
          {busy
            ? 'Saving background…'
            : dirty
              ? 'Unsaved background changes'
              : 'Background saved separately from layout'}
        </Text>
      </Group>
      {layoutDirty && (
        <Text size='xs'>
          Save or revert layout changes before editing its background.
        </Text>
      )}
      {error && (
        <Alert color='red' role='alert'>
          {error} Reload the editor after a revision conflict; local changes
          have not been discarded.
        </Alert>
      )}
      {mode && metadata && (
        <Stack gap='xs'>
          <Group wrap='wrap'>
            {(['visible', 'locked', 'aspect_locked'] as const).map((field) => (
              <Checkbox
                key={field}
                label={
                  {
                    visible: 'Show background',
                    locked: 'Lock background',
                    aspect_locked: 'Preserve aspect ratio'
                  }[field]
                }
                checked={metadata[field]}
                disabled={disabled}
                onChange={(event) =>
                  change({ [field]: event.currentTarget.checked })
                }
              />
            ))}
            <NumberInput
              label='Background opacity'
              min={0}
              max={1}
              step={0.05}
              value={metadata.opacity}
              disabled={disabled}
              onChange={(value) => {
                if (typeof value === 'number') change({ opacity: value });
              }}
            />
          </Group>
          <Group wrap='wrap'>
            {(['x', 'y', 'width', 'height'] as const).map((field) => (
              <NumberInput
                key={field}
                label={`Background ${field} (canvas fraction)`}
                value={metadata[field]}
                min={field === 'x' || field === 'y' ? -10 : 0.0001}
                max={field === 'x' || field === 'y' ? 10 : 20}
                step={0.01}
                disabled={disabled || metadata.locked}
                onChange={(value) => {
                  if (typeof value !== 'number' || !Number.isFinite(value))
                    return;
                  const patch: Partial<BackgroundMetadata> = { [field]: value };
                  if (metadata.aspect_locked && field === 'width')
                    patch.height = (value * metadata.height) / metadata.width;
                  if (metadata.aspect_locked && field === 'height')
                    patch.width = (value * metadata.width) / metadata.height;
                  change(patch);
                }}
              />
            ))}
          </Group>
          <Group>
            <Button
              disabled={disabled || past.current.length === 0}
              onClick={() => {
                const previous = past.current.pop();
                if (previous && metadata) {
                  future.current.push(metadata);
                  setMetadata(previous);
                }
              }}
            >
              Undo background
            </Button>
            <Button
              disabled={disabled || future.current.length === 0}
              onClick={() => {
                const next = future.current.pop();
                if (next && metadata) {
                  past.current.push(metadata);
                  setMetadata(next);
                }
              }}
            >
              Redo background
            </Button>
            <Button
              disabled={disabled || metadata.locked}
              onClick={() => {
                const width = Math.min(bounds.width, bounds.height * aspect);
                const height = width / aspect;
                change({
                  x: (1 - width / bounds.width) / 2,
                  y: (1 - height / bounds.height) / 2,
                  width: width / bounds.width,
                  height: height / bounds.height
                });
              }}
            >
              Fit background
            </Button>
            <Button
              disabled={disabled || !dirty}
              onClick={() => void mutate('patch')}
            >
              Save background
            </Button>
            <Button
              disabled={busy || !dirty}
              onClick={() => {
                past.current = [];
                future.current = [];
                setMetadata(document?.metadata ?? null);
              }}
            >
              Revert background
            </Button>
          </Group>
        </Stack>
      )}
      <EditorCanvas
        {...canvas}
        overlay={
          <>
            {image}
            {mode &&
              canvas.entities.map((entity) => (
                <rect
                  key={entity.id}
                  {...entity.rect}
                  fill='none'
                  stroke='var(--mantine-color-gray-6)'
                  strokeDasharray='4 2'
                />
              ))}
            {canvas.overlay}
          </>
        }
        entities={
          mode
            ? editing && rect
              ? [
                  {
                    id: 'background',
                    label: 'Background image',
                    rect,
                    fillOpacity: 0
                  }
                ]
              : []
            : canvas.entities.map((entity) => ({
                ...entity,
                fillOpacity: url && metadata?.visible ? 0.25 : undefined
              }))
        }
        selection={editing ? ['background'] : mode ? [] : canvas.selection}
        onSelect={mode ? () => undefined : canvas.onSelect}
        onClearSelection={mode ? () => undefined : canvas.onClearSelection}
        onDraw={mode ? undefined : canvas.onDraw}
        onActivate={mode ? undefined : canvas.onActivate}
        onMove={
          mode
            ? (_ids, dx, dy) => {
                if (editing && metadata)
                  change({
                    x: metadata.x + dx / bounds.width,
                    y: metadata.y + dy / bounds.height
                  });
              }
            : canvas.onMove
        }
        onResize={
          mode
            ? (_id, next) => {
                if (editing && metadata && rect) {
                  const factor =
                    next.width !== rect.width
                      ? next.width / rect.width
                      : next.height / rect.height;
                  change({
                    x: next.x / bounds.width,
                    y: next.y / bounds.height,
                    width: metadata.aspect_locked
                      ? metadata.width * factor
                      : next.width / bounds.width,
                    height: metadata.aspect_locked
                      ? metadata.height * factor
                      : next.height / bounds.height
                  });
                }
              }
            : canvas.onResize
        }
      />
    </Stack>
  );
}
