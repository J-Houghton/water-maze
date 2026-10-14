import { beforeAll, describe, expect, it } from 'vitest';
import { generateMaze } from '../src/maze/generate';
import type { Maze } from '../src/maze/types';
import { DEFAULT_PARAMS, type SimParams } from '../src/sim/params';
import { getStats, maxDelta } from '../src/sim/stats';
import { createSim, stepSim, type Sim, type SimGrid } from '../src/sim/water';

const SEED = 42;
const PARAMS: SimParams = { ...DEFAULT_PARAMS, pourRate: 0.5 };
const SETTLED = 1e-5;

/** Summed independently of stats.ts. */
function totalMass(sim: Sim): number {
  let s = 0;
  for (let i = 0; i < sim.mass.length; i++) s += sim.mass[i];
  return s;
}

function maxCell(sim: Sim): number {
  let max = 0;
  for (let i = 0; i < sim.mass.length; i++) if (sim.mass[i] > max) max = sim.mass[i];
  return max;
}

function solidIndices(grid: SimGrid): Int32Array {
  const out: number[] = [];
  for (let i = 0; i < grid.solid.length; i++) if (grid.solid[i]) out.push(i);
  return Int32Array.from(out);
}

/** Copy of the maze with the exit gap walled up. */
function sealExit(m: Maze): Maze {
  const solid = m.solid.slice();
  solid.fill(1, (m.h - m.wallWidth) * m.w);
  return { ...m, solid };
}

/** Open rectangle inside a solid frame, fed by a 3-wide chimney at x from the top row. */
function room(w: number, h: number, roomTop: number, x: number): SimGrid {
  const solid = new Uint8Array(w * h).fill(1);
  for (let y = roomTop; y < h - 1; y++) solid.fill(0, y * w + 1, y * w + w - 1);
  for (let y = 0; y < roomTop; y++) solid.fill(0, y * w + x - 1, y * w + x + 2);
  return { w, h, solid, entrance: { x, y: 0 } };
}

describe('water on a 10x10 maze, seed 42, pourRate 0.5', () => {
  const STEPS = 20000;
  let sim: Sim;
  let drainedAt = -1;
  let worstError = 0;
  let solidWithMass = 0;
  let heaviest = 0;
  /** Mass drained over the 1000 steps after the first full unit drained. */
  let outflowAfter = -1;

  beforeAll(() => {
    const maze = generateMaze(SEED, { cols: 10, rows: 10 });
    sim = createSim(maze, PARAMS);
    const solid = solidIndices(maze);
    sim.pouring = true;
    let oneDrainedAt = -1;
    let drainedThen = 0;
    for (let s = 1; s <= STEPS; s++) {
      stepSim(sim);
      worstError = Math.max(worstError, Math.abs(totalMass(sim) + sim.drained - sim.poured));
      for (let k = 0; k < solid.length; k++) if (sim.mass[solid[k]] !== 0) solidWithMass++;
      heaviest = Math.max(heaviest, maxCell(sim));
      if (drainedAt < 0 && sim.drained > 0) drainedAt = s;
      if (oneDrainedAt < 0 && sim.drained >= PARAMS.maxMass) [oneDrainedAt, drainedThen] = [s, sim.drained];
      if (s === oneDrainedAt + 1000) outflowAfter = sim.drained - drainedThen;
    }
  }, 120_000);

  it('conserves mass: sum(mass) + drained == poured within 1e-6 after every step', () => {
    expect(sim.poured).toBeGreaterThan(0);
    expect(worstError).toBeLessThan(1e-6);
  });

  it('never puts mass in a solid cell', () => {
    expect(solidWithMass).toBe(0);
  });

  it('never lets a cell exceed maxMass + maxCompress', () => {
    expect(heaviest).toBeLessThanOrEqual(PARAMS.maxMass + PARAMS.maxCompress + 1e-9);
  });

  it('drains within 20000 steps', () => {
    expect(drainedAt).toBeGreaterThan(0);
    expect(drainedAt).toBeLessThanOrEqual(STEPS);
  });

  it('reports solved with the step it first drained', () => {
    const stats = getStats(sim);
    expect(stats.solved).toBe(true);
    expect(stats.solvedAt).toBe(drainedAt);
    expect(stats.drained).toBe(sim.drained);
    expect(Math.abs(stats.mass - totalMass(sim))).toBeLessThan(1e-9);
  });

  // Regression: under the compressing CA the maze kept storing the pour as
  // compression and drained 0.2-4.5% of it long after solving.
  it('drains as fast as it is poured once the exit is reached', () => {
    expect(outflowAfter).toBeGreaterThanOrEqual(0.95 * PARAMS.pourRate * 1000);
  });
});

describe('water on the same maze with the exit sealed', () => {
  const POUR_STEPS = 2000;
  const MAX_STEPS = 50_000;
  /** Consecutive calm steps required, so a single slow step doesn't count. */
  const HOLD = 100;
  let sim: Sim;
  let settledAt = -1;
  let everDrained = false;
  let worstError = 0;
  let solidWithMass = 0;
  let heaviest = 0;

  beforeAll(() => {
    const maze = sealExit(generateMaze(SEED, { cols: 10, rows: 10 }));
    sim = createSim(maze, PARAMS);
    const solid = solidIndices(maze);
    let calm = 0;
    for (let s = 1; s <= MAX_STEPS; s++) {
      sim.pouring = s <= POUR_STEPS;
      stepSim(sim);
      if (sim.drained !== 0) everDrained = true;
      worstError = Math.max(worstError, Math.abs(totalMass(sim) + sim.drained - sim.poured));
      for (let k = 0; k < solid.length; k++) if (sim.mass[solid[k]] !== 0) solidWithMass++;
      heaviest = Math.max(heaviest, maxCell(sim));
      if (sim.pouring || maxDelta(sim) >= SETTLED) calm = 0;
      else if (++calm >= HOLD) {
        settledAt = s;
        break;
      }
    }
  }, 120_000);

  it('settles: max delta per step < 1e-5', () => {
    expect(settledAt).toBeGreaterThan(0);
  });

  it('never drains', () => {
    expect(everDrained).toBe(false);
    expect(getStats(sim).solved).toBe(false);
  });

  it('conserves mass and keeps solid cells dry', () => {
    expect(worstError).toBeLessThan(1e-6);
    expect(solidWithMass).toBe(0);
  });

  it('no cell exceeds maxMass + maxCompress after a step settles', () => {
    expect(maxCell(sim)).toBeLessThanOrEqual(PARAMS.maxMass + PARAMS.maxCompress + 1e-9);
    expect(heaviest).toBeLessThanOrEqual(PARAMS.maxMass + PARAMS.maxCompress + 1e-9);
  });
});

describe('water in a U-tube', () => {
  // Two 3-wide arms joined by a channel at the bottom. Water poured into the
  // left arm must rise in the right arm, which only pressure can do.
  const W = 13;
  const H = 24;
  const CHANNEL_TOP = 18;
  const LEFT = [1, 4];
  const RIGHT = [9, 12];

  function uTube(): SimGrid {
    const solid = new Uint8Array(W * H).fill(1);
    const clear = (x0: number, y0: number, x1: number, y1: number) => {
      for (let y = y0; y < y1; y++) solid.fill(0, y * W + x0, y * W + x1);
    };
    clear(LEFT[0], 0, LEFT[1], 22);
    clear(RIGHT[0], 1, RIGHT[1], 22);
    clear(1, CHANNEL_TOP, 12, 22);
    return { w: W, h: H, solid, entrance: { x: 2, y: 0 } };
  }

  const armMass = (sim: Sim, [x0, x1]: number[]) => {
    let s = 0;
    for (let y = 0; y < CHANNEL_TOP; y++) for (let x = x0; x < x1; x++) s += sim.mass[y * W + x];
    return s;
  };

  it('levels out in both arms to within one cell', () => {
    const sim = createSim(uTube(), PARAMS);
    sim.pouring = true;
    stepSim(sim, 200);
    sim.pouring = false;
    let calm = 0;
    for (let s = 0; s < 100_000 && calm < 100; s++) {
      stepSim(sim);
      calm = maxDelta(sim) < SETTLED ? calm + 1 : 0;
    }
    expect(calm).toBe(100);
    const left = armMass(sim, LEFT);
    const right = armMass(sim, RIGHT);
    expect(right).toBeGreaterThan(20); // about 9 rows of 3 cells each
    expect(Math.abs(left - right)).toBeLessThan(1);
  });
});

// Regression: the compressing CA stacked water up to the ceiling at the pour
// end of a wide pool (18-25 rows between highest and lowest column).
describe('water filling a wide pool', () => {
  it('keeps the pooled surface level while pouring', () => {
    const W = 62;
    const H = 30;
    const sim = createSim(room(W, H, 4, 3), PARAMS);
    sim.pouring = true;
    for (const at of [300, 600, 900]) {
      stepSim(sim, at - sim.steps);
      // Pooled height per column: full cells up from the floor plus the partial one on top.
      const heights: number[] = [];
      for (let x = 1; x < W - 1; x++) {
        let height = 0;
        for (let y = H - 2; y >= 4; y--) {
          const f = Math.min(1, sim.mass[y * W + x] / PARAMS.maxMass);
          height += f;
          if (f < 0.99) break;
        }
        heights.push(height);
      }
      expect(Math.max(...heights) - Math.min(...heights), `step ${at}`).toBeLessThan(1);
    }
  });
});

// Regression: a 20x20 maze needed ~287,000 steps when pressure only diffused.
describe('water on a 20x20 maze, seed 42', () => {
  it('drains within 30000 steps', () => {
    const sim = createSim(generateMaze(SEED, { cols: 20, rows: 20 }), PARAMS);
    sim.pouring = true;
    while (sim.solvedAt < 0 && sim.steps < 30_000) stepSim(sim, 100);
    expect(sim.solvedAt).toBeGreaterThan(0);
  }, 60_000);
});
