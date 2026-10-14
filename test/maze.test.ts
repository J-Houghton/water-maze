import { describe, expect, it } from 'vitest';
import { generateMaze } from '../src/maze/generate';
import type { Maze, MazeOptions } from '../src/maze/types';
import { cellOf, flood, interior } from './helpers';

/** Maze-cell adjacency read back from the fine `solid` grid, not from `cells`. */
function cellGraph(m: Maze): number[][] {
  const adj: number[][] = Array.from({ length: m.cols * m.rows }, () => []);
  const mid = m.wallWidth + ((m.cellScale - m.wallWidth) >> 1);
  for (let r = 0; r < m.rows; r++) {
    for (let c = 0; c < m.cols; c++) {
      const k = r * m.cols + c;
      if (c + 1 < m.cols && !m.solid[(r * m.cellScale + mid) * m.w + (c + 1) * m.cellScale]) {
        adj[k].push(k + 1);
        adj[k + 1].push(k);
      }
      if (r + 1 < m.rows && !m.solid[(r + 1) * m.cellScale * m.w + c * m.cellScale + mid]) {
        adj[k].push(k + m.cols);
        adj[k + m.cols].push(k);
      }
    }
  }
  return adj;
}

/** Shortest cell path from a to b, or null. */
function bfsPath(adj: number[][], a: number, b: number): number[] | null {
  const prev = new Int32Array(adj.length).fill(-1);
  prev[a] = a;
  const queue = [a];
  for (let q = 0; q < queue.length; q++) {
    const k = queue[q];
    if (k === b) break;
    for (const n of adj[k]) {
      if (prev[n] === -1) {
        prev[n] = k;
        queue.push(n);
      }
    }
  }
  if (prev[b] === -1) return null;
  const path = [b];
  while (path[path.length - 1] !== a) path.push(prev[path[path.length - 1]]);
  return path.reverse();
}

const CASES: Array<{ seed: number } & MazeOptions> = [
  { seed: 42, cols: 10, rows: 10 },
  { seed: 1, cols: 40, rows: 40 },
  { seed: 7, cols: 13, rows: 5 },
  { seed: 99, cols: 1, rows: 6 },
  { seed: 5, cols: 8, rows: 6, cellScale: 7, wallWidth: 3 },
];

describe.each(CASES)('maze seed=$seed $cols x $rows', ({ seed, ...opts }) => {
  it('every cell is reachable from the entrance', () => {
    const m = generateMaze(seed, opts);
    const seen = flood(m.solid, m.w, m.h, m.entrance);
    for (let i = 0; i < m.w * m.h; i++) {
      if (!m.solid[i]) expect(seen[i], `fine cell ${i % m.w},${(i / m.w) | 0}`).toBe(1);
    }
    for (let r = 0; r < m.rows; r++) {
      for (let c = 0; c < m.cols; c++) {
        const { x0, y0, x1, y1 } = interior(m, c, r);
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            expect(m.solid[y * m.w + x], `interior of cell ${c},${r}`).toBe(0);
          }
        }
        expect(seen[y0 * m.w + x0], `cell ${c},${r}`).toBe(1);
      }
    }
  });

  it('exactly one path between entrance and exit', () => {
    const m = generateMaze(seed, opts);
    const adj = cellGraph(m);
    // Spanning tree: connected (previous test) with cells - 1 passages.
    const edges = adj.reduce((n, a) => n + a.length, 0) / 2;
    expect(edges).toBe(m.cols * m.rows - 1);

    const path = bfsPath(adj, cellOf(m, m.entrance), cellOf(m, m.exit));
    expect(path).not.toBeNull();
    // Blocking any corridor cell on the path, on the fine grid the sim sees,
    // must cut the entrance off from the exit.
    for (const k of path!.slice(1, -1)) {
      const blocked = m.solid.slice();
      const { x0, y0, x1, y1 } = interior(m, k % m.cols, (k / m.cols) | 0);
      for (let y = y0; y < y1; y++) blocked.fill(1, y * m.w + x0, y * m.w + x1);
      const seen = flood(blocked, m.w, m.h, m.entrance);
      expect(seen[m.exit.y * m.w + m.exit.x], `blocked cell ${k}`).toBe(0);
    }
  });

  it('same seed gives byte-identical solid', () => {
    const a = generateMaze(seed, opts);
    const b = generateMaze(seed, opts);
    expect(Buffer.from(a.solid).equals(Buffer.from(b.solid))).toBe(true);
    expect(a.entrance).toEqual(b.entrance);
    expect(a.exit).toEqual(b.exit);
  });

  it('entrance is on row 0 and exit on the last row, both non-solid', () => {
    const m = generateMaze(seed, opts);
    expect(m.entrance.y).toBe(0);
    expect(m.exit.y).toBe(m.h - 1);
    expect(m.solid[m.entrance.y * m.w + m.entrance.x]).toBe(0);
    expect(m.solid[m.exit.y * m.w + m.exit.x]).toBe(0);
  });

  it('the outer wall is closed except for the entrance and exit gaps', () => {
    const m = generateMaze(seed, opts);
    const gap = m.cellScale - m.wallWidth;
    for (let y = 0; y < m.h; y++) {
      expect(m.solid[y * m.w]).toBe(1);
      expect(m.solid[y * m.w + m.w - 1]).toBe(1);
    }
    const openTop: number[] = [];
    const openBottom: number[] = [];
    for (let x = 0; x < m.w; x++) {
      if (!m.solid[x]) openTop.push(x);
      if (!m.solid[(m.h - 1) * m.w + x]) openBottom.push(x);
    }
    expect(openTop.length).toBe(gap);
    expect(openBottom.length).toBe(gap);
    expect(openTop).toContain(m.entrance.x);
    expect(openBottom).toContain(m.exit.x);
  });
});

describe('maze options', () => {
  it('fine grid size follows cellScale and wallWidth', () => {
    const m = generateMaze(3, { cols: 10, rows: 7 });
    expect(m.cellScale).toBe(8);
    expect(m.wallWidth).toBe(2);
    expect(m.w).toBe(10 * 8 + 2);
    expect(m.h).toBe(7 * 8 + 2);
    expect(m.solid.length).toBe(m.w * m.h);
  });

  it('different seeds give different mazes', () => {
    const a = generateMaze(1, { cols: 10, rows: 10 });
    const b = generateMaze(2, { cols: 10, rows: 10 });
    expect(Buffer.from(a.solid).equals(Buffer.from(b.solid))).toBe(false);
  });

  it('rejects corridors narrower than 4 sim cells', () => {
    expect(() => generateMaze(1, { cols: 4, rows: 4, cellScale: 5, wallWidth: 2 })).toThrow();
  });
});
