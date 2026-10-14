import { mulberry32, randInt, type Rng } from '../rng';
import { Side, type Maze, type MazeOptions } from './types';

/** Corridors narrower than this make sideways flow look wrong. */
export const MIN_CORRIDOR = 4;

/**
 * Generate a perfect maze from a seed and rasterize it to the sim grid.
 * Entrance is a gap in the top wall, exit a gap in the bottom wall.
 */
export function generateMaze(seed: number, opts: MazeOptions): Maze {
  const { cols, rows, cellScale = 8, wallWidth = 2 } = opts;
  if (cols < 1 || rows < 1) throw new Error(`maze must be at least 1x1, got ${cols}x${rows}`);
  if (cellScale - wallWidth < MIN_CORRIDOR) {
    throw new Error(
      `corridor width cellScale - wallWidth = ${cellScale - wallWidth} is below ${MIN_CORRIDOR}`,
    );
  }

  const rng = mulberry32(seed);
  const cells = carve(cols, rows, rng);
  const entranceCol = randInt(rng, cols);
  const exitCol = randInt(rng, cols);
  cells[entranceCol] |= Side.N;
  cells[(rows - 1) * cols + exitCol] |= Side.S;

  const w = cols * cellScale + wallWidth;
  const h = rows * cellScale + wallWidth;
  const solid = rasterize(cells, cols, rows, cellScale, wallWidth, w, h);
  const mid = wallWidth + ((cellScale - wallWidth) >> 1);

  return {
    w,
    h,
    solid,
    entrance: { x: entranceCol * cellScale + mid, y: 0 },
    exit: { x: exitCol * cellScale + mid, y: h - 1 },
    seed,
    cols,
    rows,
    cells,
    cellScale,
    wallWidth,
  };
}

/** Recursive backtracker (iterative, explicit stack). Returns open-side flags per cell. */
function carve(cols: number, rows: number, rng: Rng): Uint8Array {
  const n = cols * rows;
  const cells = new Uint8Array(n);
  const visited = new Uint8Array(n);
  const stack = new Int32Array(n);
  const options = new Int32Array(4);
  let top = 0;
  stack[top++] = 0;
  visited[0] = 1;

  while (top > 0) {
    const k = stack[top - 1];
    const c = k % cols;
    const r = (k / cols) | 0;
    let count = 0;
    if (r > 0 && !visited[k - cols]) options[count++] = Side.N;
    if (c < cols - 1 && !visited[k + 1]) options[count++] = Side.E;
    if (r < rows - 1 && !visited[k + cols]) options[count++] = Side.S;
    if (c > 0 && !visited[k - 1]) options[count++] = Side.W;
    if (count === 0) {
      top--;
      continue;
    }
    const side = options[randInt(rng, count)];
    let next: number;
    let back: number;
    if (side === Side.N) [next, back] = [k - cols, Side.S];
    else if (side === Side.E) [next, back] = [k + 1, Side.W];
    else if (side === Side.S) [next, back] = [k + cols, Side.N];
    else [next, back] = [k - 1, Side.E];
    cells[k] |= side;
    cells[next] |= back;
    visited[next] = 1;
    stack[top++] = next;
  }
  return cells;
}

/**
 * Fine grid: each maze cell is a cellScale block whose top and left wallWidth
 * strips are wall, plus one closing wall strip on the right and bottom.
 * Open sides clear the strip between neighbouring interiors.
 */
function rasterize(
  cells: Uint8Array,
  cols: number,
  rows: number,
  scale: number,
  wall: number,
  w: number,
  h: number,
): Uint8Array {
  const solid = new Uint8Array(w * h).fill(1);
  const clear = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = y0; y < y1; y++) solid.fill(0, y * w + x0, y * w + x1);
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const open = cells[r * cols + c];
      const x0 = c * scale + wall;
      const y0 = r * scale + wall;
      const x1 = (c + 1) * scale;
      const y1 = (r + 1) * scale;
      clear(x0, y0, x1, y1);
      if (open & Side.N) clear(x0, y0 - wall, x1, y0);
      if (open & Side.W) clear(x0 - wall, y0, x0, y1);
      // East and south strips belong to the next cell's wall, or the outer wall.
      if (open & Side.E) clear(x1, y0, x1 + wall, y1);
      if (open & Side.S) clear(x0, y1, x1, y1 + wall);
    }
  }
  return solid;
}
