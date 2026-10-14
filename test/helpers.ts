import type { Maze, Point } from '../src/maze/types';

/** 4-connected flood fill over non-solid fine cells. Returns a reached mask. */
export function flood(solid: Uint8Array, w: number, h: number, start: Point): Uint8Array {
  const seen = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  const s = start.y * w + start.x;
  if (solid[s]) return seen;
  let head = 0;
  let tail = 0;
  queue[tail++] = s;
  seen[s] = 1;
  while (head < tail) {
    const i = queue[head++];
    const x = i % w;
    const y = (i / w) | 0;
    const visit = (j: number) => {
      if (!seen[j] && !solid[j]) {
        seen[j] = 1;
        queue[tail++] = j;
      }
    };
    if (x > 0) visit(i - 1);
    if (x < w - 1) visit(i + 1);
    if (y > 0) visit(i - w);
    if (y < h - 1) visit(i + w);
  }
  return seen;
}

/** Fine-grid rectangle [x0, x1) x [y0, y1) of maze cell (c, r)'s interior, excluding walls. */
export function interior(m: Maze, c: number, r: number) {
  const x0 = c * m.cellScale + m.wallWidth;
  const y0 = r * m.cellScale + m.wallWidth;
  const size = m.cellScale - m.wallWidth;
  return { x0, y0, x1: x0 + size, y1: y0 + size };
}

/** Maze-cell index containing fine point p (gap rows map to the edge cell). */
export const cellOf = (m: Maze, p: Point) =>
  Math.min(m.rows - 1, (p.y / m.cellScale) | 0) * m.cols + ((p.x / m.cellScale) | 0);
