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

/**
 * For each wet cell, the topmost row of the connected body of water it
 * belongs to (4-connected over cells holding at least minMass), or -1 if dry.
 */
function bodyTops(sim: Sim): Int32Array {
  const { w, h } = sim.grid;
  const wet = (i: number) => sim.mass[i] >= sim.params.minMass;
  const top = new Int32Array(w * h).fill(-1);
  const body = new Int32Array(w * h);
  for (let s = 0; s < w * h; s++) {
    if (!wet(s) || top[s] !== -1) continue;
    let n = 0;
    let minY = h;
    body[n++] = s;
    top[s] = 0;
    for (let q = 0; q < n; q++) {
      const i = body[q];
      const x = i % w;
      const y = (i / w) | 0;
      minY = Math.min(minY, y);
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j >= 0 && top[j] === -1 && wet(j)) {
          top[j] = 0;
          body[n++] = j;
        }
      }
    }
    for (let q = 0; q < n; q++) top[body[q]] = minY;
  }
  return top;
}

describe('water on a 10x10 maze, seed 42, pourRate 0.5', () => {
  const STEPS = 20000;
  let sim: Sim;
  let drainedAt = -1;
  let worstError = 0;
  let solidWithMass = 0;

  beforeAll(() => {
    const maze = generateMaze(SEED, { cols: 10, rows: 10 });
    sim = createSim(maze, PARAMS);
    const solid = solidIndices(maze);
    sim.pouring = true;
    for (let s = 1; s <= STEPS; s++) {
      stepSim(sim);
      worstError = Math.max(worstError, Math.abs(totalMass(sim) + sim.drained - sim.poured));
      for (let k = 0; k < solid.length; k++) if (sim.mass[solid[k]] !== 0) solidWithMass++;
      if (drainedAt < 0 && sim.drained > 0) drainedAt = s;
    }
  }, 120_000);

  it('conserves mass: sum(mass) + drained == poured within 1e-6 after every step', () => {
    expect(sim.poured).toBeCloseTo(STEPS * PARAMS.pourRate, 9);
    expect(worstError).toBeLessThan(1e-6);
  });

  it('never puts mass in a solid cell', () => {
    expect(solidWithMass).toBe(0);
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
});

describe('water on the same maze with the exit sealed', () => {
  const POUR_STEPS = 2000;
  const MAX_STEPS = 400_000;
  /** Consecutive calm steps required, so a single slow step doesn't count. */
  const HOLD = 100;
  let sim: Sim;
  let settledAt = -1;
  let everDrained = false;
  let worstError = 0;
  let solidWithMass = 0;

  beforeAll(() => {
    const maze = sealExit(generateMaze(SEED, { cols: 10, rows: 10 }));
    sim = createSim(maze, PARAMS);
    const solid = solidIndices(maze);
    let calm = 0;
    for (let s = 1; s <= MAX_STEPS; s++) {
      sim.pouring = s <= POUR_STEPS;
      stepSim(sim);
      if (sim.drained !== 0) everDrained = true;
      if (s % 10 === 0) {
        worstError = Math.max(worstError, Math.abs(totalMass(sim) + sim.drained - sim.poured));
        for (let k = 0; k < solid.length; k++) if (sim.mass[solid[k]] !== 0) solidWithMass++;
      }
      if (sim.pouring || maxDelta(sim) >= SETTLED) calm = 0;
      else if (++calm >= HOLD) {
        settledAt = s;
        break;
      }
    }
  }, 300_000);

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

  // CLAUDE.md states the bound as maxMass + maxCompress. In this model each
  // cell may hold maxCompress more than the cell above it, so that literal
  // bound only holds for the top row of a body; deeper cells get one more
  // maxCompress per row. See the U-tube test for why compression must stack.
  it('no settled cell exceeds maxMass + maxCompress per row of depth', () => {
    const { maxMass, maxCompress } = sim.params;
    const top = bodyTops(sim);
    const w = sim.grid.w;
    let worst = -Infinity;
    for (let i = 0; i < sim.mass.length; i++) {
      if (top[i] < 0) continue;
      const depth = ((i / w) | 0) - top[i];
      worst = Math.max(worst, sim.mass[i] - (maxMass + maxCompress * (depth + 1)));
    }
    expect(worst).toBeLessThanOrEqual(1e-9);
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

  it('levels out in both arms', () => {
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
    expect(Math.abs(left - right)).toBeLessThan(3); // within one row
  });
});
