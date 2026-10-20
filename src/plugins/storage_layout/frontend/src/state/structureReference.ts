import type { StructureDocument } from '../components/StructureEditor';
import type { Rect } from './geometry';

/** Display projection only: never reinterpret or rewrite legacy logical units. */
export function projectStructure(
  structure: StructureDocument,
  bounds: { width: number; height: number }
) {
  const sx = bounds.width / structure.envelope.width;
  const sy = bounds.height / structure.envelope.height;
  return structure.features.map((feature) => ({
    ...feature,
    x: feature.x * sx,
    y: feature.y * sy,
    width: feature.width * sx,
    height: feature.height * sy
  }));
}

/** Round inward to the integer logical-unit persistence contract. */
export function fitOpening(opening: Rect): Rect {
  const x = Math.ceil(opening.x);
  const y = Math.ceil(opening.y);
  return {
    x,
    y,
    width: Math.floor(opening.x + opening.width) - x,
    height: Math.floor(opening.y + opening.height) - y
  };
}

export function containsRect(outer: Rect, inner: Rect) {
  const epsilon = 1e-7;
  return (
    inner.x >= outer.x - epsilon &&
    inner.y >= outer.y - epsilon &&
    inner.x + inner.width <= outer.x + outer.width + epsilon &&
    inner.y + inner.height <= outer.y + outer.height + epsilon
  );
}
