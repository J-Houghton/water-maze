import { describe, expect, it } from 'vitest';
import { generateMaze } from '../src/maze/generate';
import { createDroplets, updateDroplets, type Droplets } from '../src/render/droplets';
import { createField, DEPTH_CAP, ISO, prepareField, Thin } from '../src/render/field';
import { createSim, stepSim } from '../src/sim/water';

/** Grid from rows of text: '#' wall, '.' dry, '~' full, a digit d holds d / 10. */
function build(rows: string[], exitFlow = 0) {
  const h = rows.length;
  const w = rows[0].length;
  const solid = new Uint8Array(w * h);
  const mass = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = rows[y][x];
      if (c === '#') solid[y * w + x] = 1;
      else if (c === '~') mass[y * w + x] = 1;
      else if (c !== '.') mass[y * w + x] = Number(c) / 10;
    }
  }
  const field = createField(w, h, solid);
  prepareField(field, mass, 1, 0.0001, exitFlow);
  return { field, at: (x: number, y: number) => y * w + x };
}

describe('render field', () => {
  it('depth is the distance from the drawn surface, through water only', () => {
    const { field, at } = build(['#######', '#.....#', '#.....#', '#~~~~~#', '#~~~~~#', '#~~~~~#', '#######']);
    const { depth } = field;
    // Full under empty: the surface sits halfway between the two cell centres.
    expect(depth[at(3, 3)]).toBeCloseTo(0.5);
    expect(depth[at(3, 4)]).toBeCloseTo(1.5);
    expect(depth[at(3, 5)]).toBeCloseTo(2.5);
    expect(depth[at(3, 2)]).toBeCloseTo(-0.5);
    expect(depth[at(3, 1)]).toBeCloseTo(-1);
    // Walls are not air: water against a side wall is as deep as mid-pool, and the walls carry it on.
    expect(depth[at(1, 5)]).toBeCloseTo(2.5);
    expect(depth[at(0, 5)]).toBeCloseTo(2.5);
    expect(depth[at(3, 6)]).toBeCloseTo(2.5);
  });

  it('depth crosses zero where the bilinear fill crosses ISO', () => {
    const { field, at } = build(['#####', '#...#', '#777#', '#~~~#', '#####']);
    const air = field.depth[at(2, 1)];
    const water = field.depth[at(2, 2)];
    const depthZeroAt = -air / (water - air);
    const fillIsoAt = ISO / 0.7;
    expect(depthZeroAt).toBeCloseTo(fillIsoAt, 5);
    expect(field.depth[at(2, 3)]).toBeCloseTo(water + 1, 5);
  });

  it('sealed water with no air to measure from is at the depth cap', () => {
    const { field, at } = build(['#####', '#~~~#', '#~~~#', '#####']);
    for (const [x, y] of [[1, 1], [2, 1], [3, 2]]) expect(field.depth[at(x, y)]).toBe(DEPTH_CAP);
  });

  it('walls take the max of their open neighbours, diagonals at inner corners', () => {
    const { field, at } = build(['#####', '#~#.#', '#####']);
    expect(field.fill[at(2, 1)]).toBe(1);
    expect(field.fill[at(0, 0)]).toBe(1);
    expect(field.fill[at(4, 0)]).toBe(0);
    expect(field.fill[at(4, 1)]).toBe(0);
  });

  it('classifies falling streams, floor films and stream impacts', () => {
    const { field, at } = build([
      '#########',
      '#.......#',
      '#..2....#',
      '#..2....#',
      '#..2....#',
      '#..3....#',
      '#..1.~1.#',
      '#########',
    ]);
    for (let y = 2; y <= 5; y++) expect(field.thin[at(3, y)]).toBe(Thin.Falling);
    expect(field.thin[at(3, 6)]).toBe(Thin.Film);
    expect(field.thin[at(6, 6)]).toBe(Thin.Film);
    expect(Array.from(field.impacts.subarray(0, field.impactCount))).toEqual([at(3, 5)]);
    // The stream widens toward its fuller end, and the film runs halfway up to the pool beside it.
    expect(field.edgeHi[at(3, 4)]).toBeCloseTo(0.25);
    expect(field.edgeLo[at(6, 6)]).toBeCloseTo(0.55);
  });

  it('drops a lone falling cell whose run partner sits beside water (no ticks on slopes)', () => {
    const { field, at } = build(['#######', '#.....#', '#..1..#', '#..2~~#', '#~~~~~#', '#######']);
    expect(field.thin[at(3, 3)]).toBe(Thin.None);
    expect(field.thin[at(3, 2)]).toBe(Thin.None);
  });

  it('draws the exit row full of the water passing through it only while it drains', () => {
    const rows = ['#####', '#.~.#', '#.~.#', '##.##'];
    const still = build(rows, 0);
    const draining = build(rows, 0.5);
    expect(still.field.fill[still.at(2, 3)]).toBe(0);
    expect(draining.field.fill[draining.at(2, 3)]).toBe(1);
  });
});

describe('droplets', () => {
  /** A real mid-pour state, which has falling streams with impact points. */
  function scene() {
    const maze = generateMaze(42, { cols: 10, rows: 10 });
    const sim = createSim(maze, { pourRate: 0.5 });
    sim.pouring = true;
    stepSim(sim, 1500);
    const field = createField(maze.w, maze.h, maze.solid);
    prepareField(field, sim.mass, 1, 0.0001, 0);
    return { maze, field };
  }

  const snapshot = (d: Droplets) => [d.x, d.y, d.vx, d.vy, d.life].map((a) => Array.from(a));

  it('are deterministic per seed, stay out of walls, and land once nothing feeds them', () => {
    const { maze, field } = scene();
    expect(field.impactCount).toBeGreaterThan(0);
    const a = createDroplets(field, 16, maze.seed);
    const b = createDroplets(field, 16, maze.seed);
    const sources = { pourRate: 0.5, exitFlow: 0.4 };
    let below = 0;
    for (let k = 0; k < 300; k++) {
      updateDroplets(a, field, sources);
      updateDroplets(b, field, sources);
      for (let i = 0; i < a.capacity; i++) {
        if (!a.life[i]) continue;
        const cy = Math.floor(a.y[i]);
        if (cy >= maze.h) below++;
        else expect(maze.solid[cy * maze.w + Math.floor(a.x[i])]).toBe(0);
      }
    }
    expect(snapshot(a)).toEqual(snapshot(b));
    expect(a.alive).toBeGreaterThan(0);
    expect(below).toBeGreaterThan(0);

    // No pour, no outflow, no streams landing.
    const idle = { pourRate: 0, exitFlow: 0 };
    field.impactCount = 0;
    for (let k = 0; k < 255; k++) updateDroplets(a, field, idle);
    expect(a.alive).toBe(0);
  });
});
