/**
 * Physics benchmark: turns the water model's known weak spots into numbers so
 * alternative models can be compared on equal terms.
 *
 *   npm run bench [-- --quick]
 *
 * - drain: first drain step, and the step by which 1 unit has drained
 * - outflow: drain rate / pourRate over steps solvedAt+2000..+4000 (1 = flow-through)
 * - compression: share of held mass above maxMass at the first drain, and peak cell
 * - basin: surface height spread while pouring into a wide flat basin
 * - u-tube: arm level difference after pouring into one arm and settling
 * - 20x20 drain step, and ms/step on a 40x40 maze
 */
import { generateMaze } from '../src/maze/generate';
import { DEFAULT_PARAMS } from '../src/sim/params';
import { createSim, stepSim, type Sim, type SimGrid } from '../src/sim/water';

const quick = process.argv.includes('--quick');
const PARAMS = { ...DEFAULT_PARAMS, pourRate: 0.5 };
const CAP = 60_000;

function sum(a: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s;
}

function drainRun(seed: number, size: number, cap: number) {
  const sim = createSim(generateMaze(seed, { cols: size, rows: size }), PARAMS);
  sim.pouring = true;
  let worstError = 0;
  let visibleAt = -1;
  let compression = NaN;
  let peak = NaN;
  let peakY = -1;
  while (sim.steps < cap && (sim.solvedAt < 0 || visibleAt < 0)) {
    stepSim(sim);
    if (size <= 10) worstError = Math.max(worstError, Math.abs(sum(sim.mass) + sim.drained - sim.poured));
    if (sim.solvedAt === sim.steps) [compression, peak, peakY] = compressionOf(sim);
    if (visibleAt < 0 && sim.drained >= 1) visibleAt = sim.steps;
  }
  let outflow = NaN;
  if (sim.solvedAt > 0 && size <= 10) {
    stepSim(sim, Math.max(0, sim.solvedAt + 2000 - sim.steps));
    const d0 = sim.drained;
    stepSim(sim, 2000);
    outflow = (sim.drained - d0) / 2000 / PARAMS.pourRate;
  }
  return { seed, size, solvedAt: sim.solvedAt, visibleAt, outflow, compression, peak, peakY, worstError };
}

/** Share of held mass above maxMass, the peak cell mass and its row. */
function compressionOf(sim: Sim): [number, number, number] {
  const { maxMass } = sim.params;
  let held = 0;
  let excess = 0;
  let peak = 0;
  let peakAt = 0;
  for (let i = 0; i < sim.mass.length; i++) {
    const m = sim.mass[i];
    held += m;
    if (m > maxMass) excess += m - maxMass;
    if (m > peak) [peak, peakAt] = [m, i];
  }
  return [held > 0 ? excess / held : 0, peak, Math.floor(peakAt / sim.grid.w)];
}

/** Open rectangle inside a solid frame; entrance at (ex, 0) with a chimney down to the room. */
function room(w: number, h: number, roomTop: number, ex: number): SimGrid {
  const solid = new Uint8Array(w * h).fill(1);
  for (let y = roomTop; y < h - 1; y++) solid.fill(0, y * w + 1, y * w + w - 1);
  for (let y = 0; y < roomTop; y++) solid.fill(0, y * w + ex - 1, y * w + ex + 2);
  return { w, h, solid, entrance: { x: ex, y: 0 } };
}

/** Pour into the left end of a 60-wide basin; report the spread of column water heights. */
function basin() {
  const W = 62;
  const grid = room(W, 30, 4, 3);
  const sim = createSim(grid, PARAMS);
  sim.pouring = true;
  const spreads: number[] = [];
  for (const at of [300, 600, 900]) {
    stepSim(sim, at - sim.steps);
    const heights: number[] = [];
    for (let x = 1; x < W - 1; x++) {
      let hgt = 0;
      for (let y = 4; y < 29; y++) hgt += Math.min(1, sim.mass[y * W + x] / sim.params.maxMass);
      heights.push(hgt);
    }
    spreads.push(Math.max(...heights) - Math.min(...heights));
  }
  return spreads;
}

/** Two 3-wide arms joined at the bottom (same shape as the U-tube test). */
function uTube() {
  const W = 13;
  const H = 24;
  const solid = new Uint8Array(W * H).fill(1);
  const clear = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = y0; y < y1; y++) solid.fill(0, y * W + x0, y * W + x1);
  };
  clear(1, 0, 4, 22);
  clear(9, 1, 12, 22);
  clear(1, 18, 12, 22);
  const sim = createSim({ w: W, h: H, solid, entrance: { x: 2, y: 0 } }, PARAMS);
  sim.pouring = true;
  stepSim(sim, 200);
  sim.pouring = false;
  const arm = (x0: number, x1: number) => {
    let s = 0;
    for (let y = 0; y < 18; y++) for (let x = x0; x < x1; x++) s += sim.mass[y * W + x];
    return s / 3;
  };
  const levels: string[] = [];
  for (const after of [500, 2000, 20000]) {
    stepSim(sim, 200 + after - sim.steps);
    levels.push(`+${after}: ${(arm(1, 4) - arm(9, 12)).toFixed(2)} rows`);
  }
  return levels;
}

function perf() {
  const sim = createSim(generateMaze(7, { cols: 40, rows: 40 }), PARAMS);
  sim.pouring = true;
  stepSim(sim, quick ? 3000 : 20000);
  const t0 = process.hrtime.bigint();
  stepSim(sim, 1000);
  return Number(process.hrtime.bigint() - t0) / 1e6 / 1000;
}

const fmt = (v: number, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : '-');

console.log('seed  size  solvedAt  1-drained  outflow  compression  peak(row)  massErr');
for (const seed of quick ? [42] : [42, 1, 2, 3, 4]) {
  const r = drainRun(seed, 10, CAP);
  console.log(
    `${String(seed).padStart(4)}  ${'10'.padStart(4)}  ${String(r.solvedAt).padStart(8)}  ${String(r.visibleAt).padStart(9)}` +
      `  ${fmt(r.outflow).padStart(7)}  ${fmt(r.compression).padStart(11)}  ${(fmt(r.peak, 2) + `(${r.peakY})`).padStart(9)}  ${r.worstError.toExponential(1)}`,
  );
}
if (!quick) {
  const big = drainRun(42, 20, 400_000);
  console.log(`20x20 seed 42: solvedAt ${big.solvedAt}, 1-drained ${big.visibleAt}`);
}
console.log(`basin surface spread at 300/600/900 steps: ${basin().map((s) => s.toFixed(2)).join(' / ')} rows`);
console.log(`u-tube left-right level: ${uTube().join('  ')}`);
console.log(`40x40 step: ${perf().toFixed(3)} ms (x4 per frame = ${(perf() * 4).toFixed(2)} ms)`);
