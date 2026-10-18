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

describe('logical-to-physical translation integrity', () => {
  // FWD and FWD2 share controller A's output 'A-0' but are distinct strings;
  // REV is a second output on controller A; ALT lives on controller B.
  const integrity = new Map<string, StringTopology>([
    ['FWD', node('FWD', 'A', 0, 100)],
    ['FWD2', node('FWD2', 'A', 0, 100)],
    ['REV', node('REV', 'A', 200, 100)],
    ['ALT', node('ALT', 'B', 50, 100)]
  ]);

  it('rejects an overlap that a gap of equal size cancels out', () => {
    // Aggregate length is 60 + 40 = 100, exactly the requested span, so a
    // length-sum check would pass. Pixels 41-60 are covered twice while
    // 81-100 are never covered.
    const overlapping: ClientSpanInput[] = [
      {
        logical_start: 1,
        length: 60,
        string: 'FWD',
        string_offset: 0,
        direction: 1
      },
      {
        logical_start: 41,
        length: 40,
        string: 'FWD',
        string_offset: 0,
        direction: 1
      }
    ];
    expect(() => translate(overlapping, integrity, 1, 100, 100)).toThrow(
      /overlapping spans/i
    );
  });

  it('rejects a direct overlap between two spans', () => {
    const overlapping: ClientSpanInput[] = [
      {
        logical_start: 1,
        length: 50,
        string: 'FWD',
        string_offset: 0,
        direction: 1
      },
      {
        logical_start: 30,
        length: 41,
        string: 'FWD',
        string_offset: 50,
        direction: 1
      }
    ];
    expect(() => translate(overlapping, integrity, 1, 70, 100)).toThrow(
      /overlapping spans/i
    );
  });

  it('rejects a gap between two spans', () => {
    const gapped: ClientSpanInput[] = [
      {
        logical_start: 1,
        length: 40,
        string: 'FWD',
        string_offset: 0,
        direction: 1
      },
      {
        logical_start: 51,
        length: 50,
        string: 'FWD',
        string_offset: 40,
        direction: 1
      }
    ];
    expect(() => translate(gapped, integrity, 1, 100, 100)).toThrow(
      /not fully covered/i
    );
  });

  it('merges logically and physically contiguous forward spans', () => {
    const contiguous: ClientSpanInput[] = [
      {
        logical_start: 1,
        length: 50,
        string: 'FWD',
        string_offset: 0,
        direction: 1
      },
      {
        logical_start: 51,
        length: 50,
        string: 'FWD',
        string_offset: 50,
        direction: 1
      }
    ];
    const runs = translate(contiguous, integrity, 1, 100, 100);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      logical_start: 1,
      logical_end: 100,
      controller: 'A',
      string: 'FWD',
      direction: 1,
      wled_start: 0,
      wled_stop: 100
    });
  });

  it('merges logically adjacent reversed spans that are physically contiguous', () => {
    // Both spans are reversed. The first covers physical [250,300) and the
    // second [200,250): the traversal continues downward, so the runs are
    // physically contiguous and must merge into [200,300).
    const contiguous: ClientSpanInput[] = [
      {
        logical_start: 1,
        length: 50,
        string: 'REV',
        string_offset: 50,
        direction: -1
      },
      {
        logical_start: 51,
        length: 50,
        string: 'REV',
        string_offset: 0,
        direction: -1
      }
    ];
    const runs = translate(contiguous, integrity, 1, 100, 100);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      logical_start: 1,
      logical_end: 100,
      controller: 'A',
      string: 'REV',
      direction: -1,
      wled_start: 200,
      wled_stop: 300
    });
  });

  it('keeps reversed spans separate when the physical order is not continuous', () => {
    // The first span covers physical [200,250) and the second [250,300). They
    // are adjacent in the forward sense, but a reversed traversal jumps from
    // pixel 200 up to pixel 299, so they must not merge.
    const discontiguous: ClientSpanInput[] = [
      {
        logical_start: 1,
        length: 50,
        string: 'REV',
        string_offset: 0,
        direction: -1
      },
      {
        logical_start: 51,
        length: 50,
        string: 'REV',
        string_offset: 50,
        direction: -1
      }
    ];
    const runs = translate(discontiguous, integrity, 1, 100, 100);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({
      logical_start: 1,
      logical_end: 50,
      direction: -1,
      wled_start: 200,
      wled_stop: 250
    });
    expect(runs[1]).toMatchObject({
      logical_start: 51,
      logical_end: 100,
      direction: -1,
      wled_start: 250,
      wled_stop: 300
    });
  });

  it('does not merge across string, controller or direction boundaries', () => {
    const acrossString: ClientSpanInput[] = [
      {
        logical_start: 1,
        length: 50,
        string: 'FWD',
        string_offset: 0,
        direction: 1
      },
      {
        logical_start: 51,
        length: 50,
        string: 'FWD2',
        string_offset: 50,
        direction: 1
      }
    ];
    const stringRuns = translate(acrossString, integrity, 1, 100, 100);
    expect(stringRuns).toHaveLength(2);
    expect(stringRuns[0].string).toBe('FWD');
    expect(stringRuns[1].string).toBe('FWD2');

    const acrossDirection: ClientSpanInput[] = [
      {
        logical_start: 1,
        length: 50,
        string: 'FWD',
        string_offset: 0,
        direction: 1
      },
      {
        logical_start: 51,
        length: 50,
        string: 'FWD',
        string_offset: 50,
        direction: -1
      }
    ];
    const directionRuns = translate(acrossDirection, integrity, 1, 100, 100);
    expect(directionRuns).toHaveLength(2);
    expect(directionRuns[0].direction).toBe(1);
    expect(directionRuns[1].direction).toBe(-1);

    const acrossController: ClientSpanInput[] = [
      {
        logical_start: 1,
        length: 50,
        string: 'FWD',
        string_offset: 0,
        direction: 1
      },
      {
        logical_start: 51,
        length: 50,
        string: 'ALT',
        string_offset: 0,
        direction: 1
      }
    ];
    const controllerRuns = translate(acrossController, integrity, 1, 100, 100);
    expect(controllerRuns).toHaveLength(2);
    expect(controllerRuns[0].controller).toBe('A');
    expect(controllerRuns[1].controller).toBe('B');
  });

  it('does not mutate the input spans or their order', () => {
    const input: ClientSpanInput[] = [
      {
        logical_start: 51,
        length: 50,
        string: 'FWD',
        string_offset: 50,
        direction: 1
      },
      {
        logical_start: 1,
        length: 50,
        string: 'FWD',
        string_offset: 0,
        direction: 1
      }
    ];
    const snapshot = JSON.parse(JSON.stringify(input));

    translate(input, integrity, 1, 100, 100);

    expect(input).toEqual(snapshot);
    // The caller's (unsorted) order is preserved.
    expect(input.map((span) => span.logical_start)).toEqual([51, 1]);
  });

  it('rejects non-integer geometry and unknown strings', () => {
    const fractionalStart: ClientSpanInput[] = [
      {
        logical_start: 1.5,
        length: 50,
        string: 'FWD',
        string_offset: 0,
        direction: 1
      }
    ];
    expect(() => translate(fractionalStart, integrity, 1, 50, 100)).toThrow(
      /integer/i
    );

    const zeroLength: ClientSpanInput[] = [
      {
        logical_start: 10,
        length: 0,
        string: 'FWD',
        string_offset: 0,
        direction: 1
      }
    ];
    expect(() => translate(zeroLength, integrity, 1, 50, 100)).toThrow(
      /positive integer/i
    );

    const fractionalOffset: ClientSpanInput[] = [
      {
        logical_start: 1,
        length: 50,
        string: 'FWD',
        string_offset: 0.5,
        direction: 1
      }
    ];
    expect(() => translate(fractionalOffset, integrity, 1, 50, 100)).toThrow(
      /integer/i
    );

    const unknown: ClientSpanInput[] = [
      {
        logical_start: 1,
        length: 50,
        string: 'MISSING',
        string_offset: 0,
        direction: 1
      }
    ];
    expect(() => translate(unknown, integrity, 1, 50, 100)).toThrow(
      /unknown string/i
    );
  });
});
