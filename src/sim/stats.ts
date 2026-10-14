import type { Sim } from './water';

export interface SimStats {
  steps: number;
  poured: number;
  /** Mass currently in the grid. */
  mass: number;
  drained: number;
  /** Cells holding at least minMass. */
  wetCells: number;
  /** Mass that reached the exit on the latest step. */
  atExit: number;
  solved: boolean;
  /** Step on which water first drained, or -1. */
  solvedAt: number;
}

export function getStats(sim: Sim): SimStats {
  const { mass } = sim;
  const { minMass } = sim.params;
  let total = 0;
  let wet = 0;
  for (let i = 0; i < mass.length; i++) {
    total += mass[i];
    if (mass[i] >= minMass) wet++;
  }
  return {
    steps: sim.steps,
    poured: sim.poured,
    mass: total,
    drained: sim.drained,
    wetCells: wet,
    atExit: sim.lastDrained,
    solved: sim.drained > 0,
    solvedAt: sim.solvedAt,
  };
}

/** Largest per-cell mass change made by the latest step's flow. */
export function maxDelta(sim: Sim): number {
  const { mass, next } = sim;
  let max = 0;
  for (let i = 0; i < mass.length; i++) {
    const d = Math.abs(mass[i] - next[i]);
    if (d > max) max = d;
  }
  return max;
}
