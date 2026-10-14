/**
 * Headless run of maze + sim in Node, no browser.
 *
 *   npm run sim -- --seed 42 --steps 5000 [--w 10 --h 10]
 *
 * Prints stats every 500 steps, then the grid as ASCII:
 * '#' wall, '~' wet (at least minMass), ' ' dry.
 */
import { parseArgs } from 'node:util';
import { generateMaze } from '../src/maze/generate';
import { DEFAULT_PARAMS } from '../src/sim/params';
import { getStats, type SimStats } from '../src/sim/stats';
import { createSim, stepSim, type Sim } from '../src/sim/water';

const REPORT_EVERY = 500;

function intArg(values: Record<string, string | undefined>, name: string): number {
  const v = Number(values[name]);
  if (!Number.isInteger(v) || v < 0) throw new Error(`--${name} must be a non-negative integer, got ${values[name]}`);
  return v;
}

function ascii(sim: Sim): string {
  const { w, h, solid } = sim.grid;
  const { minMass } = sim.params;
  const lines: string[] = [];
  for (let y = 0; y < h; y++) {
    let line = '';
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      line += solid[i] ? '#' : sim.mass[i] >= minMass ? '~' : ' ';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

const COLUMNS = ['step', 'poured', 'mass', 'drained', 'wet', 'atExit', 'solved'];
const row = (s: SimStats) =>
  [
    s.steps,
    s.poured.toFixed(1),
    s.mass.toFixed(3),
    s.drained.toFixed(3),
    s.wetCells,
    s.atExit.toFixed(4),
    s.solved ? `yes@${s.solvedAt}` : 'no',
  ]
    .map((v) => String(v).padStart(10))
    .join('');

const { values } = parseArgs({
  options: {
    seed: { type: 'string', default: '42' },
    steps: { type: 'string', default: '5000' },
    w: { type: 'string', default: '10' },
    h: { type: 'string', default: '10' },
  },
});
const seed = intArg(values, 'seed');
const steps = intArg(values, 'steps');
const cols = intArg(values, 'w');
const rows = intArg(values, 'h');

const maze = generateMaze(seed, { cols, rows });
const sim = createSim(maze, DEFAULT_PARAMS);
sim.pouring = true;

console.log(
  `seed ${seed}, maze ${cols}x${rows}, grid ${maze.w}x${maze.h}, ` +
    `entrance (${maze.entrance.x},${maze.entrance.y}), exit (${maze.exit.x},${maze.exit.y})`,
);
console.log(`params ${JSON.stringify(sim.params)}`);
console.log(COLUMNS.map((c) => c.padStart(10)).join(''));

for (let done = 0; done < steps; ) {
  const n = Math.min(REPORT_EVERY - (done % REPORT_EVERY), steps - done);
  stepSim(sim, n);
  done += n;
  if (done % REPORT_EVERY === 0 || done === steps) console.log(row(getStats(sim)));
}

const final = getStats(sim);
console.log(
  final.solved
    ? `\nsolved: first drained at step ${final.solvedAt}`
    : `\nnot solved after ${final.steps} steps`,
);
console.log(ascii(sim));
