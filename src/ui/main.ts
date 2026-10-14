import { generateMaze } from '../maze/generate';
import type { Maze } from '../maze/types';
import { createRenderer, type Renderer } from '../render/draw';
import { DEFAULT_PARAMS, type SimParams } from '../sim/params';
import { getStats, maxDelta, type SimStats } from '../sim/stats';
import { createSim, stepSim, type Sim } from '../sim/water';
import { createPanel, type MazeControls } from './panel';

/** Deterministic driver for scripted browser checks (Playwright). */
interface SimDriver {
  /** Advance n steps, pouring unless `pour` is false, redraw, and return stats. */
  step(n: number, pour?: boolean): SimStats;
  getStats(): SimStats;
  setParams(p: Partial<SimParams>): void;
  /** New maze and empty sim; same size, given seed (default: current). */
  reset(seed?: number): void;
}

declare global {
  interface Window {
    __sim: SimDriver;
  }
}

const DEFAULT_SEED = 42;
/** 10x10 drains in about 14k steps; 20x20 needs about 290k. */
const DEFAULT_SIZE = 10;

/** Read an integer URL param, falling back when missing or invalid. */
function intParam(params: URLSearchParams, name: string, fallback: number): number {
  const v = Number.parseInt(params.get(name) ?? '', 10);
  return Number.isFinite(v) ? v : fallback;
}

const url = new URLSearchParams(location.search);
let seed = intParam(url, 'seed', DEFAULT_SEED);
const cols = Math.max(1, intParam(url, 'w', DEFAULT_SIZE));
const rows = Math.max(1, intParam(url, 'h', DEFAULT_SIZE));
const autostart = url.get('autostart') === '1';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const pourButton = document.getElementById('pour') as HTMLButtonElement;
const status = document.getElementById('status') as HTMLElement;

/** One live params object, shared by every sim and edited by the panel. */
const params: SimParams = { ...DEFAULT_PARAMS };

let maze: Maze;
let sim: Sim;
let renderer: Renderer;
/** Set by the Pour button: the rAF loop advances the sim. Scripts using __sim leave it off. */
let running = false;

const mazeControls: MazeControls = {
  seed,
  reset: () => reset(mazeControls.seed),
  regenerate: () => reset(seed + 1),
};
const panel = createPanel(params, mazeControls);

function reset(newSeed: number): void {
  seed = Math.trunc(newSeed);
  mazeControls.seed = seed;
  panel.refresh();
  maze = generateMaze(seed, { cols, rows });
  sim = createSim(maze, params);
  sim.params = params;
  renderer = createRenderer(canvas, maze);
  running = false;
  guardNote = '';
  syncPourButton();
  syncUrl();
  render();
}

/** Write the effective values back so the URL always reproduces what's on screen. */
function syncUrl(): void {
  url.set('seed', String(seed));
  url.set('w', String(cols));
  url.set('h', String(rows));
  history.replaceState(null, '', `${location.pathname}?${url}`);
}

function setPouring(on: boolean): void {
  sim.pouring = on;
  if (on) running = true;
  syncPourButton();
}

function syncPourButton(): void {
  pourButton.textContent = sim.pouring ? 'Stop pouring' : 'Pour';
}

function render(): void {
  renderer.draw(sim);
  const s = getStats(sim);
  const state = s.solved
    ? `Solved in ${s.solvedAt} steps`
    : sim.pouring
      ? 'Pouring'
      : running
        ? 'Flowing'
        : s.steps > 0
          ? 'Settled'
          : 'Ready';
  const extra = guardNote ? ` · ${guardNote}` : '';
  status.textContent = `${state} · seed ${seed} · step ${s.steps} · drained ${s.drained.toFixed(2)}${extra}`;
  status.classList.toggle('solved', s.solved);
}

/** stepsPerFrame means steps per 1/60 s tick, whatever the display's refresh rate. */
const TICK_MS = 1000 / 60;
/** After a stall (a slow frame, a background tab) catch up at most this many ticks and drop the rest. */
const MAX_CATCH_UP_TICKS = 2;
/** Sim + draw time per frame above this, sustained for LAG_FRAMES, counts as lag. */
const FRAME_BUDGET_MS = 12;
const LAG_FRAMES = 60;
/** With the pour off, still water whose cells change less than this stops being stepped. */
const SETTLED_DELTA = 1e-6;
const SETTLE_CHECK_TICKS = 30;

let smoothedFrameMs = 0;
let slowFrames = 0;
let tickCount = 0;
let guardNote = '';
let lastFrameAt = -1;
/** Sim time owed. Kept half a tick in, so rAF jitter around 60 Hz does not alternate 0 and 2 ticks. */
let owedMs = TICK_MS / 2;

/** Keep pouring after solving, but back off if the frame budget is blown: fewer steps first, then stop the pour. */
function guardFrameBudget(ms: number): void {
  smoothedFrameMs += (ms - smoothedFrameMs) * 0.1;
  if (!running || smoothedFrameMs <= FRAME_BUDGET_MS) {
    slowFrames = 0;
    return;
  }
  if (++slowFrames < LAG_FRAMES) return;
  slowFrames = 0;
  if (params.stepsPerFrame > 1) {
    params.stepsPerFrame -= 1;
    panel.refresh();
    guardNote = `slowed to ${params.stepsPerFrame} steps/frame`;
  } else if (sim.pouring) {
    setPouring(false);
    guardNote = 'pour stopped to keep the frame rate up';
  }
}

/**
 * Fixed timestep: run stepsPerFrame steps for each 1/60 s owed, so the sim
 * runs at the same speed on a 60 Hz and a 180 Hz display, and redraw only
 * when it stepped. Droplets move with the sim, so while any are in flight the
 * water does not count as settled and stepping goes on until they land.
 */
function frame(now: number): void {
  const elapsed = lastFrameAt < 0 ? 0 : now - lastFrameAt;
  lastFrameAt = now;
  const t0 = performance.now();
  let stepped = false;
  if (running) {
    owedMs += elapsed;
    let ticks = Math.min(MAX_CATCH_UP_TICKS, Math.floor(owedMs / TICK_MS));
    owedMs -= ticks * TICK_MS;
    if (owedMs >= TICK_MS) owedMs = TICK_MS / 2;
    for (; ticks > 0 && running; ticks--) {
      stepSim(sim, params.stepsPerFrame);
      stepped = true;
      // Nothing left to move: stop stepping until Pour is pressed again.
      if (
        !sim.pouring &&
        ++tickCount % SETTLE_CHECK_TICKS === 0 &&
        maxDelta(sim) < SETTLED_DELTA &&
        !renderer.animating
      ) {
        running = false;
      }
    }
  } else {
    owedMs = TICK_MS / 2;
  }
  if (stepped) {
    render();
    guardFrameBudget(performance.now() - t0);
  }
  requestAnimationFrame(frame);
}

pourButton.addEventListener('click', () => setPouring(!sim.pouring));

window.__sim = {
  step(n, pour = true) {
    sim.pouring = pour;
    syncPourButton();
    stepSim(sim, n);
    render();
    return getStats(sim);
  },
  getStats: () => getStats(sim),
  setParams(p) {
    Object.assign(params, p);
    panel.refresh();
  },
  reset(s = seed) {
    reset(s);
  },
};

reset(seed);
if (autostart) setPouring(true);
requestAnimationFrame(frame);
