# do git init, don't co author yourself ever

# Fluid Maze: notes for Claude Code

Web app: a generated maze is "solved" by pouring simulated water in at the
entrance and watching it find the exit. Hobby project, single developer,
MVP first. Everything here is a decision already made unless marked Open.

## MVP definition

Done when all of these hold in a browser:

1. A maze is generated from a seed and drawn on a canvas.
2. A "Pour" button starts water entering at the entrance cell at a steady rate.
3. Water falls under gravity, spreads sideways, pools, and rises under
   pressure, and never enters a wall cell.
4. Water reaches the exit, visibly leaves the maze there, and the app
   reports "solved" with the step count.
5. A debug panel exposes the sim parameters as live sliders.
6. `npm test` passes and covers the maze and sim invariants listed below.

Not in the MVP: air pockets, particle (FLIP/SPH) fluid, sound, mobile layout,
multiple levels. Do not add these unless asked.

## Stack

- Vite + TypeScript, no UI framework. The sim is a typed-array loop at 60 Hz
  and must not touch React or any reactive state.
- Rendering: one `<canvas>` with the 2D context. Draw the whole grid each
  frame from an `ImageData` buffer; no per-cell `fillRect` calls.
- Debug panel: `lil-gui`. One binding per sim parameter.
- Tests: `vitest`, run in Node with no DOM.
- Browser checks: Playwright MCP (see Testing).

## Layout

```
src/
  maze/
    generate.ts     seed -> Maze (wall grid). Pure.
    types.ts        Maze, Cell, Point
  sim/
    water.ts        CA water step. Pure: typed arrays in, typed arrays out.
    params.ts       SimParams with defaults and min/max for the panel
    stats.ts        mass, wet cells, water-at-exit, solved?
  render/
    draw.ts         Sim state + Maze -> ImageData -> canvas
    field.ts        fill, depth and thin-water fields at sim resolution. DOM-free.
    droplets.ts     zero-mass spray particles, own seeded RNG, stepped with the sim
  ui/
    panel.ts        lil-gui bindings
    main.ts         wiring, rAF loop, Pour button, URL params
  rng.ts            seeded PRNG (mulberry32 or similar). No Math.random anywhere.
test/
  maze.test.ts
  water.test.ts
```

`maze/` and `sim/` must not import from `render/` or `ui/`, and must not
reference `document`, `window` or `performance`. This is what makes
headless tests and a later Web Worker move possible.

## Maze

- Perfect maze (a spanning tree: exactly one path between any two cells).
  Recursive backtracker is fine; it gives long corridors, which look better
  under water than Prim's.
- Entrance is a gap in the top wall, exit is a gap in the bottom wall.
  Water needs gravity on its side; a side exit would need the maze to fill
  to that height first.
- The generator outputs maze cells. The sim runs on a finer grid:
  `cellScale` sim cells per maze cell (default 8), with walls `wallWidth`
  sim cells thick (default 2). Corridors must be at least 4 sim cells wide
  or sideways flow looks wrong.
- Output type: `{ w, h, solid: Uint8Array, entrance: Point, exit: Point,
  seed }` where `solid` is the fine grid, 1 = wall.

## Water model (cellular automaton)

Each non-solid cell holds `mass` in `[0, maxMass + compression]`. Per step,
for each cell with mass, in this order:

1. Flow down: move as much as the cell below can take.
2. Flow left and right: equalize with horizontal neighbours.
3. Flow up: only the excess above `maxMass` (pressure), by `maxCompress`.

Then a pressure pass (communicating vessels) on the result: for each
4-connected body of full cells, move water from its highest free surface to
its lowest open neighbours, lowest row first, growing through neighbours
that fill, up to `pressureRate` per body per step; then level the row where
the two meet. This is what makes U-tubes level and pressure act at once;
with `maxCompress` 0 water is incompressible and step 3 is idle.

Use two buffers (read from `mass`, write deltas into `next`) so order of
iteration does not bias the flow. Standard parameters, all in `SimParams`:

- `maxMass` 1.0, `maxCompress` 0, `minMass` 0.0001 (below this a cell is dry)
- `minFlow` 0, `maxSpeed` 1.0 (cap on mass moved per neighbour per step)
- `pressureRate` 4, mass the pressure pass may move per body per step (0 = off)
- `pourRate` mass added per step at the entrance while pouring, only into
  free room in the entrance cells (a full entrance spills)
- `stepsPerFrame` 1 to 8, for speed without changing physics

Cells at the exit opening are a sink: any mass that reaches them is counted
in `stats.drained` and removed. "Solved" = `drained > 0`.

This model is deliberately simple. If it looks wrong, tune parameters
through the panel before changing the algorithm, and record what changed
in the Decisions section below.

## Invariants (these are the tests)

Maze:
- Every cell is reachable from the entrance (flood fill).
- Exactly one path between entrance and exit (removing any corridor cell on
  the BFS path disconnects them).
- Same seed gives byte-identical `solid`.
- Entrance is on row 0 and exit on the last row, both non-solid.

Water, on a fixed seed and fixed params:
- Mass is conserved: `sum(mass) + drained == total poured` within 1e-6
  after every step.
- No solid cell ever has mass > 0.
- No cell exceeds `maxMass + maxCompress` after a step settles.
- On a 10x10 maze with `pourRate` 0.5, `drained > 0` within 20000 steps.
- On a maze with the exit sealed, mass settles (max delta per step < 1e-5)
  and never drains.

Add a test whenever a tuning change fixes a visible bug, so it stays fixed.

## Testing without a person watching

Most problems are visible in numbers before they are visible on screen. Try
these first, in order:

1. `npm test`. Invariants above.
2. A headless run script, `npm run sim -- --seed 42 --steps 5000`, that runs
   maze + sim in Node and prints `stats` every 500 steps plus an ASCII
   render of the grid at the end (`#` wall, `~` wet, ` ` dry). Read this
   before touching a browser; it catches "water stuck at the first junction"
   and "water teleports through walls" immediately.
3. Playwright MCP, for anything about how it looks. The page exposes
   `window.__sim` with `step(n)`, `getStats()`, `setParams(p)`, `reset(seed)`
   so a browser session can be driven deterministically: load
   `http://localhost:5173/?seed=42&autostart=0`, call `step(2000)`,
   screenshot, repeat. Compare screenshots across steps, not against an
   expected image.

Add Playwright MCP once, project-scoped, so it is in `.mcp.json`:

```
claude mcp add playwright --scope project -- npx -y @playwright/mcp@latest
```

When a screenshot looks wrong and the numbers look right, the bug is in
`render/`. When the numbers look wrong, do not open the browser.

## Commands

- `npm run dev`: Vite dev server on 5173.
- `npm test`: vitest, once.
- `npm run test:watch`.
- `npm run sim -- --seed N --steps N [--w N --h N]`: headless run, see above.
- `npm run build`, `npm run preview`.

URL params on the page: `seed`, `w`, `h`, `autostart` (1 = pour on load).

## Rules

- Deterministic everywhere: one seeded RNG, passed in, never global.
- Typed arrays for grids, index as `y * w + x`, no 2D arrays, no objects per cell.
- Keep the step function allocation-free; allocate buffers once in `createSim`.
- Target: a 40x40 maze at `cellScale` 8 (320x320 sim cells) runs 60 fps with
  `stepsPerFrame` 4 on a laptop. Profile before optimizing; do not reach for
  WebGL or a Worker in the MVP.
- When a change is about how the water looks rather than whether it is
  correct, stop and ask the owner to look, with the seed and params to
  reproduce. Do not iterate on aesthetics unattended.
- Commit after each milestone with a message naming the milestone.

## Milestones, in order

1. Scaffold: Vite + TS, vitest, `rng.ts`, empty panel, canvas that draws a
   checkerboard. `npm test` runs one trivial test.
2. Maze generator with its tests, drawn on the canvas, seed in the URL.
3. Water sim with its tests and the headless `sim` script. No rendering
   yet; prove it drains on a known maze from the script's output.
4. Render water on the canvas, Pour button, rAF loop, "solved" indicator.
5. Debug panel with every `SimParams` field, `stepsPerFrame`, Regenerate.
6. Playwright MCP pass: drive three seeds through `window.__sim`, screenshot
   at 0 / 25 / 50 / 100% of drain, report anything that looks off. Owner
   reviews. Tune, add regression tests for whatever was fixed.

Stop and report after milestone 3 and after milestone 6.

## Decisions

- CA water over FLIP for the MVP: simpler, handles thin walls, gives the
  "fills up" look. FLIP is a possible later swap behind the same `sim/`
  interface.
- No air model in the MVP. Where it would go: a pocket tracker over
  connected dry regions, with pressure from an ideal-gas law, gating entry
  into those cells. Not before the MVP works.
- Canvas 2D, not WebGL: adequate at the MVP grid size and easier to debug.
- `minFlow` default 0.01 -> 0 (milestone 3). Flows above `minFlow` are
  halved; flows below it are applied in full, and a full vertical correction
  applied at both faces of a cell overshoots, so deep water rings in a
  period-2 oscillation of size up to `minFlow`. At 0.01 the sealed-exit maze
  never settles below 1e-5 (still 4e-4 after 400k steps); at 0 it settles
  (seed 42, ~270k steps). Cost: seed 42 drains at 13846 steps instead of 12400.
- Cells below `minMass` hold their mass but do not flow. Otherwise
  vanishingly small amounts (1e-30 and less) spread down every open path and
  reach the exit long before any visible water, making `drained > 0` meaningless.
  Mass is still conserved.
- Pressure pass added, `maxCompress` 0.02 -> 0 (after milestone 6, at the
  owner's request). With compression, pressure only diffused through full
  water: the maze stored 70-90% of the pour as compression (cells at 11-24x
  maxMass, densest at the top), drained 0.2-4.5% of the pour after solving,
  pools sloped up to the ceiling at the pour end, and a 20x20 maze took
  ~287k steps. Researched options: speeding up the CA (constant factor only),
  a per-body communicating-vessels pass (chosen), a MAC/VOF pressure solve
  (correct but 3-8 ms/step at 40x40 and much more code), and FLIP/SPH
  particles (too slow at 40x40 in plain JS; stays the possible later swap).
  Now: no cell exceeds maxMass, outflow matches the pour after solving, pools
  fill level, seed 42 10x10 solves at step 2457 (was 13846) and 20x20 at
  ~19k. Pour is limited to free room so a full entrance spills rather than
  overfilling. `npm run bench` measures all of this; regression tests cover it.
  Known look: pressure can push a 1-cell-tall full tongue along a floor, or a
  1-cell full column down a drop.
- Full cells boxed in below and beside by full or solid cells are skipped by
  the CA when `maxCompress` is 0 (no flow is possible), which keeps a flooded
  40x40 maze within budget.
- Smooth renderer instead of one block per sim cell (owner: "very
  pixelated"). Still one ImageData and one putImageData, but at a fixed 800 px
  on the maze's long side (not times devicePixelRatio): the fill field is
  ghost-filled into walls, sampled bilinearly and cut at 0.5 with ~1 px
  antialiasing; thin streams and floor films are drawn as sub-cell bands so
  they don't vanish; colour follows distance below the surface (not mass),
  with a highlight band just inside it. Zero-mass droplets (own mulberry32
  from the maze seed) spray at the entrance, where streams land, and below
  the exit; they advance per sim step, so `__sim.step` frames are
  reproducible. Rejected: per-pixel caustics in JS (12-20 ms), blur+threshold
  at output size, ctx.filter/SVG filters (not in Safari), WebGL (overturns
  the Canvas 2D decision). Colours, widths and droplet amounts are first
  picks awaiting owner review.
- `stepsPerFrame` means steps per 1/60 s tick, not per requestAnimationFrame,
  so the sim runs at the same speed on a 60 Hz and a 180 Hz display (catch-up
  capped at 2 ticks). The canvas redraws only when the sim stepped or the
  mass scale changed; the settle check also waits for droplets to land.
  Worst case measured (40x40 fully flooded, this laptop): 6.7 ms for 4 steps
  plus 5.1 ms to draw.

## Open

- Pour rate default: whatever looks right after milestone 6.

Settled: "solved" keeps pouring (owner, after milestone 6), but the page backs
off when frame work stays over budget: fewer steps per frame first, then it
stops the pour.