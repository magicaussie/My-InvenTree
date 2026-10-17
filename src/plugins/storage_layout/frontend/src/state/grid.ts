/**
 * Bin grid generator.
 *
 * Produces a regular grid of bins inside a drawer interior. The generator is a
 * *preview*: it returns candidate rectangles together with the cells that would
 * collide with existing bins, and it never overwrites manually placed bins
 * (design section 7).
 */

import type { BinDraft } from './commands';
import { type Rect, rectsOverlap } from './geometry';

export interface GridParameters {
  /** Drawer interior dimensions. */
  interior: { width: number; height: number };
  /** Number of columns (left to right). */
  columns: number;
  /** Number of rows (top to bottom). */
  rows: number;
  /** Gutter between cells, in grid units. */
  gutter: number;
  /** Outer margin from the interior edge, in grid units. */
  margin?: number;
  /** Optional explicit cell size; when omitted cells are divided evenly. */
  cellWidth?: number;
  cellHeight?: number;
}

export interface GridCell {
  row: number;
  column: number;
  rect: Rect;
}

export interface GridPreview {
  cells: GridCell[];
  /** Cells which overlap an existing bin and would therefore be skipped. */
  collisions: GridCell[];
  totalWidth: number;
  totalHeight: number;
  fits: boolean;
}

const MIN_SIZE = 1;

function cellSize(available: number, count: number, gutter: number): number {
  if (count <= 0) return 0;
  return Math.floor((available - gutter * (count - 1)) / count);
}

/** A rectangle-like value (drawer/bin geometry). */
export interface RectLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Compute a grid preview inside a drawer interior.
 *
 * @param params Grid parameters.
 * @param existing Existing bins (in the same drawer) to test for collisions.
 */
export function generateGrid(
  params: GridParameters,
  existing: RectLike[] = []
): GridPreview {
  const margin = Math.max(0, params.margin ?? 0);
  const gutter = Math.max(0, params.gutter ?? 0);
  const columns = Math.max(1, Math.floor(params.columns));
  const rows = Math.max(1, Math.floor(params.rows));

  const availableWidth = params.interior.width - margin * 2;
  const availableHeight = params.interior.height - margin * 2;

  const width = params.cellWidth ?? cellSize(availableWidth, columns, gutter);
  const height = params.cellHeight ?? cellSize(availableHeight, rows, gutter);

  const totalWidth = columns * width + gutter * (columns - 1);
  const totalHeight = rows * height + gutter * (rows - 1);

  const fits =
    width >= MIN_SIZE &&
    height >= MIN_SIZE &&
    totalWidth <= availableWidth &&
    totalHeight <= availableHeight;

  const cells: GridCell[] = [];
  const collisions: GridCell[] = [];

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const rect: Rect = {
        x: margin + column * (width + gutter),
        y: margin + row * (height + gutter),
        width: Math.max(MIN_SIZE, width),
        height: Math.max(MIN_SIZE, height)
      };
      const cell: GridCell = { row, column, rect };

      const collides = existing.some((bin) =>
        rectsOverlap(rect, {
          x: bin.x,
          y: bin.y,
          width: bin.width,
          height: bin.height
        })
      );

      if (collides) {
        collisions.push(cell);
      } else {
        cells.push(cell);
      }
    }
  }

  return { cells, collisions, totalWidth, totalHeight, fits };
}

/** Build bin drafts for every non-colliding cell. */
export function gridToBins(
  preview: GridPreview,
  options: {
    drawerId: string;
    labelPrefix: string;
    startIndex?: number;
    newId: () => string;
  }
): BinDraft[] {
  let index = options.startIndex ?? 1;
  const bins: BinDraft[] = [];

  for (const cell of preview.cells) {
    const number = String(index).padStart(2, '0');
    bins.push({
      id: options.newId(),
      drawer: options.drawerId,
      label: `${options.labelPrefix}${number}`,
      location: null,
      x: cell.rect.x,
      y: cell.rect.y,
      width: cell.rect.width,
      height: cell.rect.height,
      archived: false
    });
    index += 1;
  }

  return bins;
}
