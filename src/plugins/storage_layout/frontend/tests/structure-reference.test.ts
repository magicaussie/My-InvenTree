import { describe, expect, it } from 'vitest';
import type { StructureDocument } from '../src/components/StructureEditor';
import {
  containsRect,
  fitOpening,
  projectStructure
} from '../src/state/structureReference';

describe('structure display projection', () => {
  const structure: StructureDocument = {
    schema_version: 1,
    units: 'mm',
    view: 'front',
    envelope: { width: 650, height: 850, depth: 450 },
    features: [
      { id: 'opening', type: 'opening', x: 13, y: 17, width: 301, height: 403 }
    ]
  };
  it('uses independent display scales without mutating geometry or identities', () => {
    const before = JSON.stringify(structure);
    const [opening] = projectStructure(structure, { width: 674, height: 840 });
    expect(opening.id).toBe('opening');
    expect(opening.width).toBeCloseTo((301 * 674) / 650);
    expect(opening.height).toBeCloseTo((403 * 840) / 850);
    const fit = fitOpening(opening);
    expect(Object.values(fit).every(Number.isInteger)).toBe(true);
    expect(containsRect(opening, fit)).toBe(true);
    expect(JSON.stringify(structure)).toBe(before);
  });
  it('does not inflate sub-unit openings to invalid drawer sizes', () => {
    const opening = { x: 0.2, y: 0.3, width: 0.4, height: 0.5 };
    expect(fitOpening(opening).width).toBeLessThan(1);
  });
  it('rejects partial containment including a drawer crossing an opening edge', () => {
    const opening = { x: 10, y: 20, width: 30, height: 40 };
    expect(containsRect(opening, opening)).toBe(true);
    expect(containsRect(opening, { ...opening, x: 9 })).toBe(false);
    expect(containsRect(opening, { ...opening, width: 31 })).toBe(false);
  });
});
