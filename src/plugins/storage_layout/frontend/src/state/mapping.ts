/**
 * Client-side logical -> physical translation.
 *
 * This is a faithful port of the pure translator owned by the backend
 * (`storage_layout/mapping.py`, design section 8). It is used to draw the
 * simulation preview and the allocation bands locally, and - importantly - to
 * assert the same invariants in the frontend test suite.
 *
 * The function is pure and never performs I/O.
 */

import type { StringInput } from '../api/types';

export interface ClientSpanInput {
  logical_start: number;
  length: number;
  /** LEDString UUID. */
  string: string;
  string_offset: number;
  direction: 1 | -1;
}

/** Resolved topology of an LED string, flattened for translation. */
export interface StringTopology {
  id: string;
  label: string;
  output_offset: number;
  pixel_count: number;
  output: {
    id: string;
    bus_index: number;
    wled_start: number;
    pixel_count: number;
    controller: { id: string; name: string };
  };
}

export interface ClientTranslationRun {
  logical_start: number;
  logical_end: number;
  controller: string;
  output: string;
  string: string;
  wled_start: number;
  wled_stop: number;
  direction: number;
}

export function logicalEnd(span: {
  logical_start: number;
  length: number;
}): number {
  return span.logical_start + span.length - 1;
}

/** Compute the controller-global WLED index for a logical pixel in a span. */
export function wledIndex(
  span: ClientSpanInput,
  topology: StringTopology,
  logical: number
): number {
  const k = logical - span.logical_start;
  const stringLocal =
    span.direction === -1
      ? span.string_offset + (span.length - 1 - k)
      : span.string_offset + k;
  const outputLocal = topology.output_offset + stringLocal;
  return topology.output.wled_start + outputLocal;
}

/**
 * Build a flat list of span inputs covering a sequence of strings in order.
 *
 * The design requires an explicit saved logical start per span, so this helper
 * only assigns starts when the caller explicitly asks for an initial proposal
 * (never implicitly renumbers existing allocations).
 */
export function proposeSpans(
  strings: StringTopology[],
  totalPixels: number
): ClientSpanInput[] {
  const spans: ClientSpanInput[] = [];
  let cursor = 1;

  for (const node of strings) {
    if (cursor > totalPixels) break;
    const length = Math.min(node.pixel_count, totalPixels - cursor + 1);
    if (length < 1) break;
    spans.push({
      logical_start: cursor,
      length,
      string: node.id,
      string_offset: 0,
      direction: 1
    });
    cursor += length;
  }

  return spans;
}

function mergeRuns(runs: ClientTranslationRun[]): ClientTranslationRun[] {
  const merged: ClientTranslationRun[] = [];

  for (const run of runs) {
    const previous = merged[merged.length - 1];
    if (
      previous &&
      previous.controller === run.controller &&
      previous.output === run.output &&
      previous.string === run.string &&
      previous.direction === run.direction &&
      previous.logical_end + 1 === run.logical_start &&
      physicallyAdjacent(previous, run)
    ) {
      previous.logical_end = run.logical_end;
      // The merged run must span the full physical half-open interval. For a
      // forward run the later logical pixels are physically higher, so the
      // bounds extend upward; for a reversed run they extend downward. Taking
      // the min/max of both bounds covers either case.
      previous.wled_start = Math.min(previous.wled_start, run.wled_start);
      previous.wled_stop = Math.max(previous.wled_stop, run.wled_stop);
      continue;
    }
    merged.push({ ...run });
  }

  return merged;
}

/**
 * Decide whether two logically adjacent runs are also contiguous in physical
 * WLED space.
 *
 * A forward run traverses its half-open interval from low to high, so the next
 * run must begin exactly where the previous one stopped
 * (``previous.wled_stop === run.wled_start``). A reversed run traverses from
 * high to low, so the next run must begin exactly one pixel below the previous
 * run's lowest pixel (``run.wled_stop === previous.wled_start``). Using the
 * forward test for reversed runs would merge physically discontiguous spans.
 */
function physicallyAdjacent(
  previous: ClientTranslationRun,
  run: ClientTranslationRun
): boolean {
  return run.direction === -1
    ? run.wled_stop === previous.wled_start
    : previous.wled_stop === run.wled_start;
}

/**
 * Translate an inclusive logical range into ordered physical runs.
 *
 * @throws Error when the range is invalid or not fully covered by the spans.
 */
export function translate(
  spans: ClientSpanInput[],
  topologyById: Map<string, StringTopology>,
  logicalStart: number,
  logicalEndValue: number,
  totalPixels?: number
): ClientTranslationRun[] {
  if (
    !Number.isInteger(logicalStart) ||
    !Number.isInteger(logicalEndValue) ||
    logicalStart < 1 ||
    logicalEndValue < logicalStart
  ) {
    throw new Error('Logical range must satisfy 1 <= start <= end');
  }

  if (totalPixels !== undefined && logicalEndValue > totalPixels) {
    throw new Error('Logical range must not exceed the mapping size');
  }

  const ordered = [...spans].sort((a, b) => a.logical_start - b.logical_start);

  // Select the spans that intersect the requested interval, validating their
  // geometry and string references as we go. Only intersecting spans are
  // validated so unrelated mapping rows cannot fail an otherwise valid
  // translation. Validation is deterministic and follows logical order.
  const intersecting: ClientSpanInput[] = [];

  for (const span of ordered) {
    const rawEnd = span.logical_start + span.length - 1;
    if (rawEnd < logicalStart || span.logical_start > logicalEndValue) {
      continue;
    }

    if (!Number.isInteger(span.logical_start)) {
      throw new Error(
        `Span logical_start must be an integer (got ${span.logical_start})`
      );
    }
    if (!Number.isInteger(span.length) || span.length < 1) {
      throw new Error(
        `Span length must be a positive integer (got ${span.length})`
      );
    }
    if (!Number.isInteger(span.string_offset)) {
      throw new Error(
        `Span string_offset must be an integer (got ${span.string_offset})`
      );
    }
    if (!topologyById.has(span.string)) {
      throw new Error(`Span references unknown string ${span.string}`);
    }

    intersecting.push(span);
  }

  // Establish exact, gap-free, non-overlapping coverage of the requested
  // interval. Aggregate covered length is not sufficient: overlapping spans can
  // duplicate coverage while a gap elsewhere keeps the totals equal. Walking
  // the spans in logical order and requiring each to start exactly at the next
  // uncovered pixel rejects both gaps and overlaps.
  let cursor = logicalStart;

  for (let index = 0; index < intersecting.length; index += 1) {
    const span = intersecting[index];

    if (span.logical_start > cursor) {
      throw new Error(
        `Logical range ${logicalStart}-${logicalEndValue} is not fully covered`
      );
    }
    if (index > 0 && span.logical_start < cursor) {
      throw new Error(
        `Logical range ${logicalStart}-${logicalEndValue} has overlapping spans`
      );
    }

    cursor = logicalEnd(span) + 1;
  }

  if (cursor <= logicalEndValue) {
    throw new Error(
      `Logical range ${logicalStart}-${logicalEndValue} is not fully covered`
    );
  }

  const runs: ClientTranslationRun[] = [];

  for (const span of intersecting) {
    const topology = topologyById.get(span.string);
    if (!topology) {
      throw new Error(`Span references unknown string ${span.string}`);
    }

    const a = Math.max(logicalStart, span.logical_start);
    const z = Math.min(logicalEndValue, logicalEnd(span));
    const wa = wledIndex(span, topology, a);
    const wz = wledIndex(span, topology, z);

    runs.push({
      logical_start: a,
      logical_end: z,
      controller: topology.output.controller.id,
      output: topology.output.id,
      string: topology.id,
      wled_start: Math.min(wa, wz),
      wled_stop: Math.max(wa, wz) + 1,
      direction: span.direction
    });
  }

  return mergeRuns(runs);
}

/** Flatten an electrical topology document into resolvable string nodes. */
export function topologyFromDocument(
  controllers: {
    id: string | null;
    name: string;
    outputs: {
      id: string | null;
      bus_index: number;
      wled_start: number;
      pixel_count: number;
      strings: StringInput[];
    }[];
  }[]
): Map<string, StringTopology> {
  const map = new Map<string, StringTopology>();

  for (const controller of controllers) {
    if (!controller.id) continue;
    for (const output of controller.outputs) {
      if (!output.id) continue;
      for (const string of output.strings) {
        if (!string.id) continue;
        map.set(string.id, {
          id: string.id,
          label: string.label,
          output_offset: string.output_offset,
          pixel_count: string.pixel_count,
          output: {
            id: output.id,
            bus_index: output.bus_index,
            wled_start: output.wled_start,
            pixel_count: output.pixel_count,
            controller: { id: controller.id, name: controller.name }
          }
        });
      }
    }
  }

  return map;
}
