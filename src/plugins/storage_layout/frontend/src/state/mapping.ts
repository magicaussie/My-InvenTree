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
      previous.wled_stop === run.wled_start
    ) {
      previous.logical_end = run.logical_end;
      previous.wled_stop = run.wled_stop;
      continue;
    }
    merged.push({ ...run });
  }

  return merged;
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

  const runs: ClientTranslationRun[] = [];

  for (const span of ordered) {
    const spanEnd = logicalEnd(span);
    if (spanEnd < logicalStart || span.logical_start > logicalEndValue) {
      continue;
    }

    const topology = topologyById.get(span.string);
    if (!topology) {
      throw new Error(`Span references unknown string ${span.string}`);
    }

    const a = Math.max(logicalStart, span.logical_start);
    const z = Math.min(logicalEndValue, spanEnd);
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

  const merged = mergeRuns(runs);
  const covered = merged.reduce(
    (total, run) => total + (run.logical_end - run.logical_start + 1),
    0
  );

  if (covered !== logicalEndValue - logicalStart + 1) {
    throw new Error(
      `Logical range ${logicalStart}-${logicalEndValue} is not fully covered`
    );
  }

  return merged;
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
