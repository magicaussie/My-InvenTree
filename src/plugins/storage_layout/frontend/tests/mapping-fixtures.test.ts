/**
 * Shared mapping-translation fixture parity tests (TypeScript side).
 *
 * This suite consumes the single canonical fixture at
 * `src/plugins/storage_layout/shared/mapping_fixtures.json`. The Python suite
 * (`storage_layout/tests/test_mapping_fixtures.py`) consumes the *same* file, so
 * the two translators cannot drift: any divergence in forward/reverse handling,
 * multi-controller splitting, split outputs, gaps, overlaps, partial ranges or
 * zero-based half-open physical indices fails one of the two suites.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  type ClientSpanInput,
  type StringTopology,
  topologyFromDocument,
  translate
} from '../src/state/mapping';

interface FixtureString {
  id: string;
  label: string;
  output_offset: number;
  pixel_count: number;
  archived: boolean;
}

interface FixtureOutput {
  id: string;
  bus_index: number;
  wled_start: number;
  pixel_count: number;
  strings: FixtureString[];
}

interface FixtureController {
  id: string;
  name: string;
  outputs: FixtureOutput[];
}

interface FixtureSpanSpec {
  logical_start: number;
  length: number;
  string: string;
  string_offset: number;
  direction: 1 | -1;
}

interface FixtureCase {
  name: string;
  topology: string;
  total_pixels: number;
  spans: FixtureSpanSpec[];
  request: { start: number; end: number };
  expect: { runs?: unknown[]; error?: string };
}

interface FixtureDocument {
  schema_version: number;
  topologies: Record<string, { controllers: FixtureController[] }>;
  cases: FixtureCase[];
}

// Vitest runs with the frontend directory as its working directory, so the
// canonical fixture lives one level up under the plugin distribution root.
const fixturePath = resolve(
  process.cwd(),
  '..',
  'shared',
  'mapping_fixtures.json'
);

const document: FixtureDocument = JSON.parse(
  readFileSync(fixturePath, 'utf-8')
);

function topologyFor(id: string): Map<string, StringTopology> {
  const topology = document.topologies[id];
  if (!topology) throw new Error(`missing topology ${id}`);
  return topologyFromDocument(topology.controllers);
}

function spansFor(
  topologyId: string,
  specs: FixtureSpanSpec[]
): ClientSpanInput[] {
  const topology = topologyFor(topologyId);
  return specs.map((spec) => {
    if (!topology.has(spec.string)) {
      throw new Error(`missing string ${spec.string}`);
    }
    return {
      logical_start: spec.logical_start,
      length: spec.length,
      string: spec.string,
      string_offset: spec.string_offset,
      direction: spec.direction
    };
  });
}

describe('shared mapping fixture parity', () => {
  it('loads a canonical fixture with cases', () => {
    expect(document.schema_version).toBe(1);
    expect(document.cases.length).toBeGreaterThan(0);
  });

  for (const testCase of document.cases) {
    it(testCase.name, () => {
      const spans = spansFor(testCase.topology, testCase.spans);
      const topology = topologyFor(testCase.topology);
      const { start, end } = testCase.request;

      if (testCase.expect.error) {
        expect(() =>
          translate(spans, topology, start, end, testCase.total_pixels)
        ).toThrow(new RegExp(testCase.expect.error, 'i'));
      } else {
        const runs = translate(
          spans,
          topology,
          start,
          end,
          testCase.total_pixels
        );
        expect(runs).toEqual(testCase.expect.runs);
      }
    });
  }
});
