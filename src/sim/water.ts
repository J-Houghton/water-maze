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
  /** The open run of cells around the entrance, nearest the entrance first. */
  readonly pourCells: Int32Array;
  readonly scratch: PressureScratch;
  pouring: boolean;
  steps: number;
  /** Mass actually added; a pour into a full entrance spills and is not counted. */
  poured: number;
  drained: number;
  /** Mass that reached the exit on the latest step. */
  lastDrained: number;
  /** Step on which water first drained, or -1. */
  solvedAt: number;
}

/** Buffers for the pressure pass, allocated once with the sim. */
interface PressureScratch {
  /** Body id of each full cell, -1 if none. */
  label: Int32Array;
  stack: Int32Array;
  /** Body that last queued each cell as a target, so it is queued once per body. */
  mark: Int32Array;
  /** Dedupes cells while levelling a row. */
  rowMark: Int32Array;
  stamp: number;
  /** Source cells of the current body. */
  src: Int32Array;
  /** Targets bucketed by row: qHead[row] -> qNext[cell] -> ... -> -1. */
  qHead: Int32Array;
  qNext: Int32Array;
  /** Lowest and highest row queued for the current body. */
  qRange: Int32Array;
  /** Source water per row, and the fraction each source row keeps. */
  rowS: Float64Array;
  keep: Float64Array;
}

/** Allocates every buffer the sim will use; stepping allocates nothing. */
export function createSim(grid: SimGrid, params: Partial<SimParams> = {}): Sim {
  const { w, h, solid, entrance } = grid;
  const n = w * h;
  const sinks: number[] = [];
  for (let x = 0; x < w; x++) if (!solid[(h - 1) * w + x]) sinks.push((h - 1) * w + x);

  const pour: number[] = [];
  const row = entrance.y * w;
  for (let x = entrance.x; x >= 0 && !solid[row + x]; x--) pour.push(row + x);
  for (let x = entrance.x + 1; x < w && !solid[row + x]; x++) pour.push(row + x);
  const centre = row + entrance.x;
  pour.sort((a, b) => Math.abs(a - centre) - Math.abs(b - centre) || a - b);

  return {
    grid,
    params: { ...DEFAULT_PARAMS, ...params },
    mass: new Float64Array(n),
    next: new Float64Array(n),
    sinks: Int32Array.from(sinks),
    pourCells: Int32Array.from(pour),
    scratch: {
      label: new Int32Array(n),
      stack: new Int32Array(n),
      mark: new Int32Array(n),
      rowMark: new Int32Array(n),
      stamp: 0,
      src: new Int32Array(n),
      qHead: new Int32Array(h).fill(-1),
      qNext: new Int32Array(n),
      qRange: new Int32Array(2),
      rowS: new Float64Array(h),
      keep: new Float64Array(h),
    },
    pouring: false,
    steps: 0,
    poured: 0,
    drained: 0,
    lastDrained: 0,
    solvedAt: -1,
  };
}

/** Advance n steps: pour, flow, pressure, drain the exit, swap buffers. */
export function stepSim(sim: Sim, n = 1): void {
  const { w, h, solid } = sim.grid;
  const { sinks, pourCells } = sim;
  for (let s = 0; s < n; s++) {
    const p = sim.params;
    if (sim.pouring && p.pourRate > 0) {
      // Fill from the entrance outwards, only into free room: a full entrance spills.
      const mass = sim.mass;
      let left = p.pourRate;
      for (let k = 0; k < pourCells.length && left > 0; k++) {
        const i = pourCells[k];
        const add = Math.min(left, p.maxMass - mass[i]);
        if (add <= 0) continue;
        mass[i] += add;
        left -= add;
      }
      sim.poured += p.pourRate - left;
    }

    flowStep(solid, w, h, sim.mass, sim.next, p);
    if (p.pressureRate > 0) pressurePass(sim, sim.next);

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
  // Without compression a full cell boxed in below and beside by full or solid
  // cells has nowhere to flow, so the bulk of a flooded maze can be skipped.
  const incompressible = maxCompress === 0;
  next.set(mass);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const m = mass[i];
      if (m < minMass || solid[i]) continue;
      if (
        incompressible &&
        m >= maxMass &&
        (y + 1 >= h || solid[i + w] || mass[i + w] >= maxMass) &&
        (x === 0 || solid[i - 1] || mass[i - 1] >= maxMass) &&
        (x + 1 >= w || solid[i + 1] || mass[i + 1] >= maxMass)
      ) {
        continue;
      }
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

/** Cells holding at least this share of maxMass are full: part of a body that carries pressure. */
const FULL_SHARE = 0.99;

/**
 * Communicating vessels. The CA alone moves water through full regions only by
 * slow diffusion, so pressure barely travels. This pass makes it act at once:
 * for each 4-connected body of full cells it moves water from the body's
 * highest free surface (and water resting on it) to its lowest open
 * neighbours, lowest row first. A neighbour that fills joins the body and its
 * own open neighbours join the queue (a priority flood), so water can be
 * pushed through an opening and onward in one step. It stops when the highest
 * source row meets the lowest target row or pressureRate is spent, then levels
 * that row. Cells pressed against a ceiling are never sources. Every change is
 * a transfer between cells, so mass is conserved.
 */
function pressurePass(sim: Sim, m: Float64Array): void {
  const { w, h, solid } = sim.grid;
  const { maxMass, minMass, pressureRate } = sim.params;
  const sc = sim.scratch;
  const { label, stack, mark, rowMark, src, qHead, qNext, qRange, rowS, keep } = sc;
  const full = maxMass * FULL_SHARE;
  label.fill(-1);
  mark.fill(-1);
  let body = 0;

  for (let seed = 0; seed < w * h; seed++) {
    if (label[seed] >= 0 || solid[seed] || m[seed] < full) continue;

    // 1. Flood the body. Sources: body cells open to the air above, and water
    //    resting on them. Targets: open, non-full neighbours, bucketed by row.
    let sp = 0;
    let ns = 0;
    let rMin = h;
    let rMax = -1;
    stack[sp++] = seed;
    label[seed] = body;
    qRange[0] = h;
    qRange[1] = -1;
    while (sp > 0) {
      const c = stack[--sp];
      const x = c % w;
      const y = (c - x) / w;
      if (y < rMin) rMin = y;
      if (y > rMax) rMax = y;
      if (y === 0) {
        src[ns++] = c;
      } else if (!solid[c - w]) {
        const nb = c - w;
        if (m[nb] >= full) {
          if (label[nb] < 0) {
            label[nb] = body;
            stack[sp++] = nb;
          }
        } else {
          if (m[nb] > minMass) src[ns++] = nb;
          if (mark[nb] !== body) enqueue(nb, body, w, sc);
          src[ns++] = c;
        }
      }
      if (y + 1 < h) sp = visit(c + w, body, full, w, m, solid, sc, sp);
      if (x > 0) sp = visit(c - 1, body, full, w, m, solid, sc, sp);
      if (x + 1 < w) sp = visit(c + 1, body, full, w, m, solid, sc, sp);
    }

    if (ns > 0 && qRange[1] >= 0) {
      const r0 = Math.max(0, rMin - 1);
      const r1 = Math.min(h - 1, rMax + 1);
      for (let r = r0; r <= r1; r++) {
        rowS[r] = 0;
        keep[r] = 1;
      }
      for (let k = 0; k < ns; k++) if (m[src[k]] > minMass) rowS[(src[k] / w) | 0] += m[src[k]];
      let sr = r0;
      while (sr <= r1 && !(rowS[sr] > 0)) sr++;
      let tr = qRange[1];
      let budget = pressureRate;
      let moved = 0;
      // Highest row filled as a target; sources at or below it are left alone,
      // so no cell is both drained and filled in one pass.
      let minFilled = h;

      // 2. Fill the lowest target from the highest sources, growing the
      //    frontier through targets that fill.
      while (budget > 1e-15 && sr <= r1) {
        while (tr >= 0 && qHead[tr] < 0) tr--;
        if (tr < 0 || tr <= sr) break;
        const t = qHead[tr];
        qHead[tr] = qNext[t];
        const room = maxMass - m[t];
        if (room <= 0) continue;
        const want = Math.min(room, budget);
        let got = 0;
        while (got < want && sr < tr && sr < minFilled) {
          const take = Math.min(want - got, rowS[sr]);
          keep[sr] *= 1 - take / rowS[sr];
          rowS[sr] -= take;
          got += take;
          if (!(rowS[sr] > 1e-15)) {
            rowS[sr] = 0;
            sr++;
            while (sr <= r1 && !(rowS[sr] > 0)) sr++;
          }
        }
        if (got > 0 && tr < minFilled) minFilled = tr;
        m[t] += got;
        budget -= got;
        moved += got;
        if (m[t] < maxMass - 1e-12) {
          // Partly filled: budget or sources ran out. Put it back and stop.
          qNext[t] = qHead[tr];
          qHead[tr] = t;
          break;
        }
        // Filled: it joins the body and its open neighbours become targets.
        label[t] = body;
        const x = t % w;
        const y = (t - x) / w;
        if (y + 1 < h) queueIfOpen(t + w, body, maxMass, w, m, solid, sc);
        if (x > 0) queueIfOpen(t - 1, body, maxMass, w, m, solid, sc);
        if (x + 1 < w) queueIfOpen(t + 1, body, maxMass, w, m, solid, sc);
        if (y > 0) queueIfOpen(t - w, body, maxMass, w, m, solid, sc);
        if (tr + 1 < h && qHead[tr + 1] >= 0) tr++;
      }

      // 3. Take what was moved from the source rows, each cell by its row's share.
      if (moved > 0) {
        for (let k = 0; k < ns; k++) {
          const s = src[k];
          const r = (s / w) | 0;
          if (keep[r] !== 1 && m[s] > minMass) m[s] *= keep[r];
        }
      }

      // 4. Where the highest sources and lowest targets share a row, level it.
      if (budget > 1e-15 && sr <= r1) {
        while (tr >= 0 && qHead[tr] < 0) tr--;
        if (tr === sr) {
          const stamp = ++sc.stamp;
          let total = 0;
          let count = 0;
          for (let k = 0; k < ns; k++) {
            const s = src[k];
            if (((s / w) | 0) === sr && rowMark[s] !== stamp) {
              rowMark[s] = stamp;
              total += m[s];
              count++;
            }
          }
          for (let t = qHead[sr]; t >= 0; t = qNext[t]) {
            if (rowMark[t] !== stamp) {
              rowMark[t] = stamp;
              total += m[t];
              count++;
            }
          }
          const mean = total / count;
          if (count > 1 && mean <= maxMass) {
            for (let k = 0; k < ns; k++) if (((src[k] / w) | 0) === sr) m[src[k]] = mean;
            for (let t = qHead[sr]; t >= 0; t = qNext[t]) m[t] = mean;
          }
        }
      }
    }

    for (let r = Math.max(0, qRange[0]); r <= Math.min(h - 1, qRange[1]); r++) qHead[r] = -1;
    body++;
  }
}

/** Flood step for a side or lower neighbour: join the body if full, else queue it as a target. Returns the stack size. */
function visit(
  nb: number,
  body: number,
  full: number,
  w: number,
  m: Float64Array,
  solid: Uint8Array,
  sc: PressureScratch,
  sp: number,
): number {
  if (solid[nb]) return sp;
  if (m[nb] >= full) {
    if (sc.label[nb] < 0) {
      sc.label[nb] = body;
      sc.stack[sp++] = nb;
    }
  } else if (sc.mark[nb] !== body) {
    enqueue(nb, body, w, sc);
  }
  return sp;
}

/** Queue a neighbour of a newly filled target, if it is open, not full and new to this body. */
function queueIfOpen(
  nb: number,
  body: number,
  maxMass: number,
  w: number,
  m: Float64Array,
  solid: Uint8Array,
  sc: PressureScratch,
): void {
  if (!solid[nb] && m[nb] < maxMass && sc.mark[nb] !== body && sc.label[nb] < 0) enqueue(nb, body, w, sc);
}

/** Add a target to its row's bucket. Kept top-level: as a closure it measured ~2x slower. */
function enqueue(t: number, body: number, w: number, sc: PressureScratch): void {
  sc.mark[t] = body;
  const r = (t / w) | 0;
  sc.qNext[t] = sc.qHead[r];
  sc.qHead[r] = t;
  if (r < sc.qRange[0]) sc.qRange[0] = r;
  if (r > sc.qRange[1]) sc.qRange[1] = r;
}
