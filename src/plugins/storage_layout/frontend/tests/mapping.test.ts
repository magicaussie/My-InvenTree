import { describe, expect, it } from 'vitest';

import {
  type ClientSpanInput,
  proposeSpans,
  type StringTopology,
  topologyFromDocument,
  translate,
  wledIndex
} from '../src/state/mapping';

function node(
  id: string,
  controller: string,
  outputWledStart: number,
  pixelCount: number,
  controllerName = controller
): StringTopology {
  return {
    id,
    label: id,
    output_offset: 0,
    pixel_count: pixelCount,
    output: {
      id: `${controller}-${outputWledStart}`,
      bus_index: 0,
      wled_start: outputWledStart,
      pixel_count: pixelCount,
      controller: { id: controller, name: controllerName }
    }
  };
}

const topology = new Map<string, StringTopology>([
  ['S1', node('S1', 'A', 0, 50)],
  ['S2', node('S2', 'A', 80, 30)],
  ['S3', node('S3', 'B', 10, 40)]
]);

const spans: ClientSpanInput[] = [
  {
    logical_start: 1,
    length: 50,
    string: 'S1',
    string_offset: 0,
    direction: 1
  },
  {
    logical_start: 51,
    length: 30,
    string: 'S2',
    string_offset: 0,
    direction: 1
  },
  {
    logical_start: 81,
    length: 40,
    string: 'S3',
    string_offset: 0,
    direction: 1
  }
];

describe('client mapping translator (design section 8 example)', () => {
  function topo(id: string): StringTopology {
    const node = topology.get(id);
    if (!node) throw new Error(`missing topology ${id}`);
    return node;
  }

  it('maps the endpoints of each string', () => {
    expect(wledIndex(spans[0], topo('S1'), 1)).toBe(0);
    expect(wledIndex(spans[0], topo('S1'), 50)).toBe(49);
    expect(wledIndex(spans[1], topo('S2'), 51)).toBe(80);
    expect(wledIndex(spans[1], topo('S2'), 80)).toBe(109);
    expect(wledIndex(spans[2], topo('S3'), 81)).toBe(10);
    expect(wledIndex(spans[2], topo('S3'), 120)).toBe(49);
  });

  it('splits drawer [45,90] into three runs covering 46 pixels', () => {
    const runs = translate(spans, topology, 45, 90, 120);
    expect(runs).toHaveLength(3);
    expect(runs[0]).toMatchObject({
      logical_start: 45,
      logical_end: 50,
      controller: 'A',
      wled_start: 44,
      wled_stop: 50
    });
    expect(runs[1]).toMatchObject({
      logical_start: 51,
      logical_end: 80,
      controller: 'A',
      wled_start: 80,
      wled_stop: 110
    });
    expect(runs[2]).toMatchObject({
      logical_start: 81,
      logical_end: 90,
      controller: 'B',
      wled_start: 10,
      wled_stop: 20
    });
    const covered = runs.reduce(
      (total, run) => total + (run.logical_end - run.logical_start + 1),
      0
    );
    expect(covered).toBe(46);
  });

  it('honours a reversed span direction', () => {
    const reversed: ClientSpanInput[] = [
      spans[0],
      { ...spans[1], direction: -1 },
      spans[2]
    ];
    const whole = translate(reversed, topology, 51, 80, 120);
    expect(whole).toHaveLength(1);
    expect(whole[0].wled_start).toBe(80);
    expect(whole[0].wled_stop).toBe(110);

    const subrange = translate(reversed, topology, 51, 55, 120);
    expect(subrange[0].wled_start).toBe(105);
    expect(subrange[0].wled_stop).toBe(110);
    expect(subrange[0].direction).toBe(-1);
  });

  it('never merges runs across controllers', () => {
    const runs = translate(spans, topology, 1, 120, 120);
    const controllers = new Set(runs.map((run) => run.controller));
    expect(controllers.size).toBe(2);
  });

  it('rejects invalid ranges and uncovered gaps', () => {
    expect(() => translate(spans, topology, 0, 10, 120)).toThrow();
    expect(() => translate(spans, topology, 10, 5, 120)).toThrow();
    expect(() => translate(spans, topology, 1, 121, 120)).toThrow();
    // A gap in coverage between 50 and 51 is detected.
    const gappy = [spans[0], { ...spans[1], logical_start: 60 }];
    expect(() => translate(gappy, topology, 1, 80, 120)).toThrow();
  });

  it('proposes sequential spans without renumbering other spans', () => {
    const proposed = proposeSpans([...topology.values()], 100);
    expect(proposed.map((span) => span.logical_start)).toEqual([1, 51, 81]);
    expect(proposed[1].length).toBe(30);
    expect(proposed[2].length).toBe(20);
  });

  it('flattens an electrical document into resolvable string nodes', () => {
    const map = topologyFromDocument([
      {
        id: 'c1',
        name: 'Controller A',
        outputs: [
          {
            id: 'o1',
            bus_index: 0,
            wled_start: 0,
            pixel_count: 10,
            strings: [
              {
                id: 's1',
                label: 'S1',
                output_offset: 0,
                pixel_count: 10,
                archived: false
              }
            ]
          }
        ]
      }
    ]);
    expect(map.get('s1')?.output.controller.name).toBe('Controller A');
    expect(map.get('s1')?.output.wled_start).toBe(0);
  });
});
