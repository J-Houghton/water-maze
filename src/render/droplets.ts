/**
 * Decorative droplets: zero-mass, render-side particles that never touch the
 * sim. Fixed-capacity typed arrays allocated once, spawned into a ring buffer
 * (a full buffer overwrites the oldest), driven by their own seeded RNG and
 * advanced once per sim step, so the same steps always give the same frame.
 * Units are sim cells and sim steps. DOM-free.
 */
import { mulberry32, type Rng } from '../rng';
import type { WaterField } from './field';

const CAPACITY = 2048;
/** Cells per step per step. */
const GRAVITY = 0.035;
/** Fall speed cap, cells per step. Below the 2-cell wall width, so droplets cannot tunnel through a wall. */
const MAX_FALL = 0.9;
/** Updates a droplet lives at most. Fits in the Uint8Array. */
const MAX_LIFE = 120;
/** A droplet falling into water at least this full rejoins it. */
const REJOIN_FILL = 0.6;

/** Droplets per unit of mass poured, spread across the entrance gap. */
const POUR_DROPS = 0.3;
/** Chance per step that a stream impact throws 1 to 3 droplets. */
const IMPACT_CHANCE = 0.06;
/**
 * Droplets per unit of mass drained, below the exit, at most MAX_EXIT_DROPS
 * per step. While anything drains there are at least MIN_EXIT_DROPS per step
 * on average, so a thin film reaching the exit still visibly leaves the maze.
 */
const EXIT_DROPS = 3;
const MIN_EXIT_DROPS = 0.12;
const MAX_EXIT_DROPS = 4;

export interface Droplets {
  readonly capacity: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  /** Updates left to live; 0 = free slot. */
  readonly life: Uint8Array;
  /** Slot the next droplet spawns into. */
  head: number;
  /** Live droplets. */
  alive: number;
  readonly rng: Rng;
  /** Entrance gap [pourX0, pourX1) on the top row and exit gap on the bottom row, in cells. */
  readonly pourX0: number;
  readonly pourX1: number;
  readonly exitX0: number;
  readonly exitX1: number;
  /** Rows of open air below the maze that droplets fall through before they leave. */
  readonly belowRows: number;
}

/** What feeds the emitters on one update. Read-only views of the sim's state. */
export interface DropletSources {
  /** Mass poured per step at the entrance; 0 when not pouring. */
  pourRate: number;
  /** Mass drained at the exit on the latest step. */
  exitFlow: number;
}

export function createDroplets(field: WaterField, belowRows: number, seed: number): Droplets {
  const { w, solid, exits } = field;
  let pourX0 = w;
  let pourX1 = 0;
  for (let x = 0; x < w; x++) {
    if (solid[x]) continue;
    pourX0 = Math.min(pourX0, x);
    pourX1 = x + 1;
  }
  const exitX0 = exits.length ? exits[0] % w : 0;
  const exitX1 = exits.length ? (exits[exits.length - 1] % w) + 1 : 0;
  return {
    capacity: CAPACITY,
    x: new Float32Array(CAPACITY),
    y: new Float32Array(CAPACITY),
    vx: new Float32Array(CAPACITY),
    vy: new Float32Array(CAPACITY),
    life: new Uint8Array(CAPACITY),
    head: 0,
    alive: 0,
    // A stream of its own, distinct from the maze generator's for the same seed.
    rng: mulberry32(Math.imul(seed ^ 0x5bd1e995, 0x27d4eb2d)),
    pourX0,
    pourX1: Math.max(pourX0, pourX1),
    exitX0,
    exitX1,
    belowRows,
  };
}

function spawn(d: Droplets, x: number, y: number, vx: number, vy: number): void {
  const k = d.head;
  d.head = (k + 1) % d.capacity;
  if (!d.life[k]) d.alive++;
  d.x[k] = x;
  d.y[k] = y;
  d.vx[k] = vx;
  d.vy[k] = vy;
  d.life[k] = MAX_LIFE;
}

/** One update, for one sim step: emit from the entrance, stream impacts and the exit, then move. */
export function updateDroplets(d: Droplets, field: WaterField, src: DropletSources): void {
  const { w, h, fill, impacts } = field;
  const rng = d.rng;

  // Spray falling in through the entrance gap with the pour.
  if (src.pourRate > 0 && d.pourX1 > d.pourX0) {
    for (let n = Math.floor(src.pourRate * POUR_DROPS + rng()); n > 0; n--) {
      const x = d.pourX0 + rng() * (d.pourX1 - d.pourX0);
      spawn(d, x, rng() * 0.5, (rng() - 0.5) * 0.04, 0.2 + rng() * 0.25);
    }
  }

  // Splashes where a thin falling stream lands, kicked up harder by fuller streams.
  for (let k = 0; k < field.impactCount; k++) {
    if (rng() >= IMPACT_CHANCE) continue;
    const i = impacts[k];
    const cx = i % w;
    const cy = (i - cx) / w;
    const kick = 0.6 + fill[i];
    for (let n = 1 + Math.floor(rng() * 3); n > 0; n--) {
      spawn(d, cx + 0.5 + (rng() - 0.5) * 0.8, cy + 0.95, (rng() - 0.5) * 0.35, -(0.08 + rng() * 0.18) * kick);
    }
  }

  // Water leaving the maze, at a rate that follows the outflow.
  if (src.exitFlow > 0 && d.exitX1 > d.exitX0) {
    const n = Math.min(MAX_EXIT_DROPS, Math.floor(Math.max(MIN_EXIT_DROPS, src.exitFlow * EXIT_DROPS) + rng()));
    for (let k = 0; k < n; k++) {
      const x = d.exitX0 + rng() * (d.exitX1 - d.exitX0);
      spawn(d, x, h + rng() * 0.3, (rng() - 0.5) * 0.1, 0.15 + rng() * 0.3);
    }
  }

  moveDroplets(d, field);
}

/** Gravity, then death on a wall, off the grid, at the end of life, or on falling back into water. */
function moveDroplets(d: Droplets, field: WaterField): void {
  const { w, h, solid, fill } = field;
  const { x, y, vx, vy, life } = d;
  const bottom = h + d.belowRows;
  let alive = 0;
  for (let k = 0; k < d.capacity; k++) {
    if (!life[k]) continue;
    const v = Math.min(MAX_FALL, vy[k] + GRAVITY);
    vy[k] = v;
    x[k] += vx[k];
    y[k] += v;
    const cx = Math.floor(x[k]);
    const cy = Math.floor(y[k]);
    let dead = --life[k] === 0 || cx < 0 || cx >= w || y[k] < 0 || cy >= bottom;
    if (!dead && cy < h) {
      const i = cy * w + cx;
      dead = solid[i] === 1 || (v > 0 && fill[i] > REJOIN_FILL);
    }
    if (dead) life[k] = 0;
    else alive++;
  }
  d.alive = alive;
}
