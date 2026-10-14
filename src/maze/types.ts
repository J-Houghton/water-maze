/** Integer grid coordinate. On the fine (sim) grid unless noted. */
export interface Point {
  x: number;
  y: number;
}

/** Open-side bit flags for one maze cell. */
export const Side = { N: 1, E: 2, S: 4, W: 8 } as const;

/** One maze cell: a bitmask of its open sides (Side.N | Side.E | ...). */
export type Cell = number;

export interface MazeOptions {
  /** Maze cells across and down. */
  cols: number;
  rows: number;
  /** Sim cells per maze cell. Default 8. */
  cellScale?: number;
  /** Wall thickness in sim cells. Default 2. */
  wallWidth?: number;
}

export interface Maze {
  /** Fine (sim) grid size: cols * cellScale + wallWidth, likewise for rows. */
  w: number;
  h: number;
  /** Fine grid, index y * w + x, 1 = wall. */
  solid: Uint8Array;
  /** Middle of the entrance gap, on row 0. */
  entrance: Point;
  /** Middle of the exit gap, on row h - 1. */
  exit: Point;
  seed: number;
  /** The maze-cell grid that `solid` was rasterized from. */
  cols: number;
  rows: number;
  /** Open sides per maze cell, index row * cols + col. */
  cells: Uint8Array;
  cellScale: number;
  wallWidth: number;
}
