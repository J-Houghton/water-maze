import type { Point } from '../maze/types';
import { DEFAULT_PARAMS, type SimParams } from './params';

/** The part of a Maze the sim needs. */
export interface SimGrid {
  w: number;
  h: number;
  solid: Uint8Array;
  entrance: Point;
}

export interface Sim {
  readonly grid: SimGrid;
  /** Live parameters; mutate freely between steps. */
  params: SimParams;
  /** Water mass per cell, index y * w + x. */
  mass: Float64Array;
  /** Scratch buffer. After a step it holds the state before that step's flow. */
  next: Float64Array;
  /** Non-solid cells on the bottom row: the exit opening. */
  readonly sinks: Int32Array;
  pouring: boolean;
  steps: number;
  poured: number;
  drained: number;
  /** Mass that reached the exit on the latest step. */
  lastDrained: number;
  /** Step on which water first drained, or -1. */
  solvedAt: number;
}

/** Allocates every buffer the sim will use; stepping allocates nothing. */
export function createSim(grid: SimGrid, params: Partial<SimParams> = {}): Sim {
  const { w, h, solid } = grid;
  const sinks: number[] = [];
  for (let x = 0; x < w; x++) if (!solid[(h - 1) * w + x]) sinks.push((h - 1) * w + x);
  return {
    grid,
    params: { ...DEFAULT_PARAMS, ...params },
    mass: new Float64Array(w * h),
    next: new Float64Array(w * h),
    sinks: Int32Array.from(sinks),
    pouring: false,
    steps: 0,
    poured: 0,
    drained: 0,
    lastDrained: 0,
    solvedAt: -1,
  };
}

/** Advance n steps: pour, flow, drain the exit, swap buffers. */
export function stepSim(sim: Sim, n = 1): void {
  const { w, h, solid, entrance } = sim.grid;
  const sinks = sim.sinks;
  const pourAt = entrance.y * w + entrance.x;
  for (let s = 0; s < n; s++) {
    const p = sim.params;
    if (sim.pouring && p.pourRate > 0) {
      sim.mass[pourAt] += p.pourRate;
      sim.poured += p.pourRate;
    }

    flowStep(solid, w, h, sim.mass, sim.next, p);

    const next = sim.next;
    let out = 0;
    for (let k = 0; k < sinks.length; k++) {
      out += next[sinks[k]];
      next[sinks[k]] = 0;
    }
    sim.lastDrained = out;
    sim.drained += out;

    sim.next = sim.mass;
    sim.mass = next;
    sim.steps++;
    if (sim.solvedAt < 0 && out > 0) sim.solvedAt = sim.steps;
  }
}

/**
 * Mass the lower of two stacked cells holds at rest when they share `total`:
 * full cells stack with maxCompress more in the lower one.
 */
function stableBelow(total: number, maxMass: number, maxCompress: number): number {
  if (total <= maxMass) return maxMass;
  if (total < 2 * maxMass + maxCompress) {
    return (maxMass * maxMass + total * maxCompress) / (maxMass + maxCompress);
  }
  return (total + maxCompress) / 2;
}

/**
 * One cellular-automaton water step. Reads only `mass`, writes the result to
 * `next`, so iteration order does not bias the flow. Every flow is subtracted
 * from one cell and added to another, so mass is conserved. Dry cells
 * (below minMass) hold their mass but do not flow.
 */
export function flowStep(
  solid: Uint8Array,
  w: number,
  h: number,
  mass: Float64Array,
  next: Float64Array,
  p: SimParams,
): void {
  const { maxMass, maxCompress, minMass, minFlow, maxSpeed } = p;
  next.set(mass);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const m = mass[i];
      if (m < minMass || solid[i]) continue;
      let remaining = m;

      // 1. Down: as much as the cell below can take.
      if (y + 1 < h && !solid[i + w]) {
        const below = mass[i + w];
        let flow = stableBelow(remaining + below, maxMass, maxCompress) - below;
        if (flow > minFlow) flow *= 0.5;
        flow = Math.max(0, Math.min(flow, maxSpeed, remaining));
        next[i] -= flow;
        next[i + w] += flow;
        remaining -= flow;
        if (remaining <= 0) continue;
      }

      // 2. Left and right: equalize, both sides sharing what remains.
      let left = 0;
      let right = 0;
      if (x > 0 && !solid[i - 1]) {
        left = (m - mass[i - 1]) / 4;
        if (left > minFlow) left *= 0.5;
      }
      if (x + 1 < w && !solid[i + 1]) {
        right = (m - mass[i + 1]) / 4;
        if (right > minFlow) right *= 0.5;
      }
      left = Math.max(0, Math.min(left, maxSpeed));
      right = Math.max(0, Math.min(right, maxSpeed));
      const sideways = left + right;
      if (sideways > remaining) {
        const k = remaining / sideways;
        left *= k;
        right *= k;
      }
      if (left > 0) {
        next[i] -= left;
        next[i - 1] += left;
        remaining -= left;
      }
      if (right > 0) {
        next[i] -= right;
        next[i + 1] += right;
        remaining -= right;
      }
      if (remaining <= 0) continue;

      // 3. Up: only compressed water, the excess the cell above should hold less of.
      if (y > 0 && !solid[i - w]) {
        const above = mass[i - w];
        let flow = remaining - stableBelow(remaining + above, maxMass, maxCompress);
        if (flow > minFlow) flow *= 0.5;
        flow = Math.max(0, Math.min(flow, maxSpeed, remaining));
        next[i] -= flow;
        next[i - w] += flow;
      }
    }
  }
}
