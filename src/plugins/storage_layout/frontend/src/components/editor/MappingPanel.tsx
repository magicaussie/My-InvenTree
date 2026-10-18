/**
 * Mapping preview and publish panel.
 *
 * Candidate spans are edited explicitly: the panel never assigns a logical
 * start implicitly when strings are reordered (design section 8). Previewing
 * performs no persistence and no hardware I/O; publishing produces an
 * immutable mapping revision only when the candidate fully covers `1..N`.
 */

import { t } from '@lingui/core/macro';
import {
  Alert,
  Badge,
  Button,
  Divider,
  Group,
  NumberInput,
  Select,
  Stack,
  Table,
  Text,
  TextInput
} from '@mantine/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { StorageLayoutClient } from '../../api/client';
import {
  type MappingPreviewResponse,
  type MappingPublishResponse,
  type ReplacementAllocation,
  StorageLayoutApiError
} from '../../api/types';
import {
  type ClientSpanInput,
  type StringTopology,
  translate
} from '../../state/mapping';
import { formatRange, rangeCount } from '../../utils';

export interface MappingPanelProps {
  client: StorageLayoutClient;
  cabinetId: string;
  totalPixels: number;
  topology: StringTopology[];
  readOnly: boolean;
  etag?: string | null;
  replacementAllocations?: ReplacementAllocation[];
  onPublished?: () => void;
}

interface SpanRow extends ClientSpanInput {
  key: string;
}

/**
 * A successful publish is authoritative, but it only describes the candidate
 * that was sent. The signature records that candidate so the panel can tell a
 * still-current publication apart from one superseded by later local edits.
 */
interface PublishedSnapshot {
  response: MappingPublishResponse;
  signature: string;
}

function toCandidate(row: SpanRow): ClientSpanInput {
  return {
    logical_start: row.logical_start,
    length: row.length,
    string: row.string,
    string_offset: row.string_offset,
    direction: row.direction
  };
}

/** Stable identity of a candidate, used to detect edits since a publish. */
function candidateSignature(size: number, spans: SpanRow[]): string {
  return JSON.stringify({
    total_pixels: size,
    spans: spans.map(toCandidate)
  });
}

function coverageDiagnostics(
  spans: ClientSpanInput[],
  totalPixels: number
): string[] {
  const errors: string[] = [];
  const sorted = [...spans].sort((a, b) => a.logical_start - b.logical_start);
  let cursor = 1;

  for (const span of sorted) {
    if (span.logical_start < 1 || span.length < 1) {
      errors.push(t`Spans must start at 1 or greater with positive length.`);
      break;
    }
    if (span.logical_start !== cursor) {
      errors.push(
        t`Logical coverage gap or overlap at ${cursor} (next span starts at ${span.logical_start}).`
      );
      break;
    }
    cursor = span.logical_start + span.length;
  }

  if (errors.length === 0 && cursor - 1 !== totalPixels) {
    errors.push(
      t`Coverage ends at ${cursor - 1} but the mapping size is ${totalPixels}.`
    );
  }

  return errors;
}

export function MappingPanel({
  client,
  cabinetId,
  totalPixels,
  topology,
  readOnly,
  etag,
  replacementAllocations = [],
  onPublished
}: MappingPanelProps) {
  const [size, setSize] = useState(totalPixels || 1);
  const initialSpans = useMemo<SpanRow[]>(() => {
    const rows: SpanRow[] = [];
    let start = 1;
    for (const node of topology) {
      if (start > size) break;
      const length = Math.min(node.pixel_count, size - start + 1);
      if (length < 1) break;
      rows.push({
        key: `${node.id}-${start}`,
        logical_start: start,
        length,
        string: node.id,
        string_offset: 0,
        direction: 1
      });
      start += length;
    }
    return rows;
    // Recompute only when the topology identity or size changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topology, size]);

  const [spans, setSpans] = useState<SpanRow[]>(initialSpans);
  const [hash, setHash] = useState<string | null>(null);
  const [preview, setPreview] = useState<MappingPreviewResponse | null>(null);
  const [published, setPublished] = useState<PublishedSnapshot | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Monotonic version of the candidate/preview state. Every candidate change
  // and every new preview request bumps it, so a preview response (or error)
  // that resolves against an obsolete candidate is discarded instead of
  // overwriting current state.
  const requestSeq = useRef(0);
  // Count of in-flight preview/publish operations, so `busy` stays accurate
  // even when a stale completion is ignored.
  const inFlight = useRef(0);
  // Guards against dispatching a second publish while one is in flight.
  const publishing = useRef(false);

  /**
   * Invalidate any preview/hash/message derived from the previous candidate.
   * Called for every candidate change: span field edits, Add span, total
   * logical pixels and the topology-driven proposal reset. A prior successful
   * publish is *not* undone; it is retained and marked stale at render time.
   */
  const invalidateCandidate = useCallback(() => {
    requestSeq.current += 1;
    setHash(null);
    setPreview(null);
    setMessage(null);
  }, []);

  // Re-propose spans whenever the topology or the mapping size changes (the
  // electrical document loads asynchronously after the mapping panel mounts).
  useEffect(() => {
    setSpans(initialSpans);
    invalidateCandidate();
  }, [initialSpans, invalidateCandidate]);

  // Switching cabinet invalidates any preview/hash/message from the previous
  // one, so a late response cannot be shown against the new cabinet.
  const previousCabinet = useRef(cabinetId);
  useEffect(() => {
    if (previousCabinet.current === cabinetId) return;
    previousCabinet.current = cabinetId;
    invalidateCandidate();
  }, [cabinetId, invalidateCandidate]);

  const errors = coverageDiagnostics(spans, size);

  const topologyMap = useMemo(() => {
    const map = new Map<string, StringTopology>();
    for (const node of topology) map.set(node.id, node);
    return map;
  }, [topology]);

  const update = (index: number, patch: Partial<SpanRow>) => {
    setSpans((current) => {
      const next = [...current];
      next[index] = { ...next[index], ...patch };
      return next;
    });
    invalidateCandidate();
  };

  const addSpan = () => {
    setSpans((current) => [
      ...current,
      {
        key: `span-${current.length}-${Date.now()}`,
        logical_start:
          current.length === 0
            ? 1
            : current[current.length - 1].logical_start +
              current[current.length - 1].length,
        length: 1,
        string: topology[0]?.id ?? '',
        string_offset: 0,
        direction: 1
      }
    ]);
    invalidateCandidate();
  };

  const runPreview = useCallback(async () => {
    // Ignore duplicate dispatch while another operation is in flight.
    if (inFlight.current > 0) return;
    const seq = ++requestSeq.current;
    inFlight.current += 1;
    setBusy(true);
    setMessage(null);
    try {
      const result = await client.mappingPreview(cabinetId, {
        total_pixels: size,
        spans: spans.map(toCandidate)
      });
      // Discard a response that resolved against an obsolete candidate.
      if (seq !== requestSeq.current) return;
      setPreview(result);
      setHash(result.mapping_hash);
    } catch (error) {
      if (seq !== requestSeq.current) return;
      const apiError =
        error instanceof StorageLayoutApiError
          ? error
          : new StorageLayoutApiError(String(error), 0);
      setMessage(apiError.message);
    } finally {
      inFlight.current = Math.max(0, inFlight.current - 1);
      if (inFlight.current === 0) setBusy(false);
    }
  }, [cabinetId, client, size, spans]);

  const publish = useCallback(async () => {
    // Never issue a second publish while one is in flight.
    if (inFlight.current > 0 || publishing.current) return;
    publishing.current = true;
    inFlight.current += 1;
    setBusy(true);
    setMessage(null);
    // Record the candidate this publish describes, so a later local edit can
    // be distinguished from the published snapshot.
    const signature = candidateSignature(size, spans);
    try {
      const result = await client.mappingPublish(
        cabinetId,
        {
          total_pixels: size,
          spans: spans.map(toCandidate),
          replacement_allocations: replacementAllocations
        },
        etag
      );
      // A successful server response is authoritative even if the candidate
      // changed locally while the request was in flight; it is simply shown as
      // describing the snapshot that was sent, not the current edits.
      setPublished({ response: result, signature });
      setMessage(
        t`Published mapping revision ${result.number} (N=${result.total_pixels}, hash ${result.mapping_hash.slice(0, 8)}…).`
      );
      onPublished?.();
    } catch (error) {
      const apiError =
        error instanceof StorageLayoutApiError
          ? error
          : new StorageLayoutApiError(String(error), 0);
      setMessage(apiError.message);
    } finally {
      publishing.current = false;
      inFlight.current = Math.max(0, inFlight.current - 1);
      if (inFlight.current === 0) setBusy(false);
    }
  }, [
    cabinetId,
    client,
    size,
    spans,
    replacementAllocations,
    etag,
    onPublished
  ]);

  const localSamples = useMemo(() => {
    if (errors.length > 0 || !hash) return [];
    try {
      return [1, Math.ceil(size / 2), size].map((logical) => ({
        logical,
        runs: translate(spans, topologyMap, logical, logical, size)
      }));
    } catch {
      return [];
    }
  }, [errors, hash, size, spans, topologyMap]);

  const rows = preview?.samples ?? localSamples;

  // A published snapshot is stale once the candidate no longer matches it.
  const currentSignature = useMemo(
    () => candidateSignature(size, spans),
    [size, spans]
  );
  const publishedStale = published
    ? published.signature !== currentSignature
    : false;

  return (
    <Stack gap='sm' data-testid='mapping-panel'>
      <Group gap='xs'>
        <Text fw={600}>{t`Mapping`}</Text>
        <Badge variant='light'>{t`No hardware access`}</Badge>
        <Badge color={errors.length === 0 ? 'green' : 'red'} variant='light'>
          {errors.length === 0
            ? t`Coverage complete`
            : t`${errors.length} issue(s)`}
        </Badge>
      </Group>

      <Group gap='xs' align='flex-end'>
        <NumberInput
          size='xs'
          w={120}
          label={t`Total logical pixels (N)`}
          min={1}
          value={size}
          readOnly={readOnly}
          onChange={(value) => {
            setSize(Number(value) || 1);
            invalidateCandidate();
          }}
        />
        <Button
          size='xs'
          variant='default'
          onClick={() => void runPreview()}
          loading={busy}
          disabled={errors.length > 0}
        >
          {t`Preview`}
        </Button>
        <Button
          size='xs'
          onClick={() => void publish()}
          loading={busy}
          disabled={readOnly || errors.length > 0}
        >
          {t`Publish mapping`}
        </Button>
      </Group>

      {errors.length > 0 ? (
        <Alert color='red' title={t`Candidate is not publishable`}>
          <Stack gap={2}>
            {errors.map((error) => (
              <Text size='sm' key={error}>
                {error}
              </Text>
            ))}
          </Stack>
        </Alert>
      ) : null}

      {message ? (
        <Alert color='blue' withCloseButton onClose={() => setMessage(null)}>
          {message}
        </Alert>
      ) : null}

      <Table withTableBorder striped>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t`Logical start`}</Table.Th>
            <Table.Th>{t`Length`}</Table.Th>
            <Table.Th>{t`String`}</Table.Th>
            <Table.Th>{t`Offset`}</Table.Th>
            <Table.Th>{t`Direction`}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {spans.map((span, index) => (
            <Table.Tr key={span.key}>
              <Table.Td>
                <NumberInput
                  size='xs'
                  min={1}
                  value={span.logical_start}
                  readOnly={readOnly}
                  onChange={(value) =>
                    update(index, { logical_start: Number(value) || 1 })
                  }
                />
              </Table.Td>
              <Table.Td>
                <NumberInput
                  size='xs'
                  min={1}
                  value={span.length}
                  readOnly={readOnly}
                  onChange={(value) =>
                    update(index, { length: Number(value) || 1 })
                  }
                />
              </Table.Td>
              <Table.Td>
                <Select
                  size='xs'
                  data={topology.map((node) => ({
                    value: node.id,
                    label: `${node.output.controller.name}/${node.label}`
                  }))}
                  value={span.string}
                  disabled={readOnly}
                  onChange={(value) =>
                    value && update(index, { string: value })
                  }
                />
              </Table.Td>
              <Table.Td>
                <NumberInput
                  size='xs'
                  min={0}
                  value={span.string_offset}
                  readOnly={readOnly}
                  onChange={(value) =>
                    update(index, { string_offset: Number(value) || 0 })
                  }
                />
              </Table.Td>
              <Table.Td>
                <Select
                  size='xs'
                  data={[
                    { value: '1', label: t`Forward` },
                    { value: '-1', label: t`Reversed` }
                  ]}
                  value={String(span.direction)}
                  disabled={readOnly}
                  onChange={(value) =>
                    update(index, { direction: value === '-1' ? -1 : 1 })
                  }
                />
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>

      <Group gap='xs'>
        <Button
          size='xs'
          variant='default'
          disabled={readOnly}
          onClick={addSpan}
        >
          {t`Add span`}
        </Button>
        <TextInput
          size='xs'
          w={280}
          label={t`Mapping hash`}
          value={hash ?? ''}
          readOnly
          aria-label={t`Mapping hash`}
        />
      </Group>

      <Divider label={t`Translation sample`} labelPosition='center' />
      {rows.length === 0 ? (
        <Text size='sm' c='dimmed'>
          {t`Run a preview to see sample logical to physical translations.`}
        </Text>
      ) : (
        <Stack gap='xs' data-testid='translation-sample'>
          {rows.map((sample) => (
            <Group key={sample.logical} gap='xs'>
              <Badge variant='light'>L{sample.logical}</Badge>
              {sample.runs.map((run) => (
                <Text size='xs' key={`${sample.logical}-${run.logical_start}`}>
                  L{formatRange(run.logical_start, run.logical_end)} (
                  {rangeCount(run.logical_start, run.logical_end)}) →{' '}
                  {run.controller}:{run.wled_start}-{run.wled_stop}
                  {run.direction === -1 ? ' (reversed)' : ''}
                </Text>
              ))}
            </Group>
          ))}
        </Stack>
      )}

      {preview?.drawer_impacts && preview.drawer_impacts.length > 0 ? (
        <Alert
          color={
            preview.drawer_impacts.some((impact) => !impact.valid)
              ? 'red'
              : 'blue'
          }
          title={t`Drawer impacts`}
        >
          <Stack gap={2} data-testid='drawer-impacts'>
            {preview.drawer_impacts.map((impact) => (
              <Text size='sm' key={impact.drawer}>
                {impact.valid
                  ? t`${impact.label} (L${formatRange(impact.logical_start, impact.logical_end)}): ${impact.runs.length} run(s)`
                  : t`${impact.label} (L${formatRange(impact.logical_start, impact.logical_end)}): ${impact.error ?? 'invalid'}`}
              </Text>
            ))}
          </Stack>
        </Alert>
      ) : null}

      {published ? (
        <Alert
          color='blue'
          variant='light'
          data-testid='publish-result'
          title={t`Published mapping`}
        >
          <Stack gap={2}>
            <Text size='sm'>
              {published.response.changed_truncated
                ? t`Revision ${published.response.number}, N=${published.response.total_pixels}, ${published.response.changed_count ?? 0} physical pixel(s) changed (list truncated).`
                : t`Revision ${published.response.number}, N=${published.response.total_pixels}, ${published.response.changed_count ?? 0} physical pixel(s) changed.`}
            </Text>
            {published.response.changed_pixels &&
            published.response.changed_pixels.length > 0 ? (
              <Text size='xs' c='dimmed'>
                {t`e.g. logical ${published.response.changed_pixels[0].logical}: ${published.response.changed_pixels[0].before?.join(':') ?? 'none'} → ${published.response.changed_pixels[0].after?.join(':') ?? 'none'}`}
              </Text>
            ) : null}
            {publishedStale ? (
              <Text size='xs' c='dimmed' data-testid='publish-stale'>
                {t`The candidate has been edited since this revision was published; publish again to apply the current edits.`}
              </Text>
            ) : null}
          </Stack>
        </Alert>
      ) : null}

      {replacementAllocations.length > 0 ? (
        <Alert color='orange' title={t`Replacement allocations attached`}>
          {t`${replacementAllocations.length} drawer allocation(s) will be replaced atomically when this mapping is published.`}
        </Alert>
      ) : null}
    </Stack>
  );
}
