import { generateMaze } from '../maze/generate';
import type { Maze } from '../maze/types';
import { createRenderer, type Renderer } from '../render/draw';
import { DEFAULT_PARAMS, type SimParams } from '../sim/params';
import { getStats, type SimStats } from '../sim/stats';
import { createSim, stepSim, type Sim } from '../sim/water';
import { createPanel } from './panel';

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

function reset(newSeed: number): void {
  seed = newSeed;
  maze = generateMaze(seed, { cols, rows });
  sim = createSim(maze, params);
  sim.params = params;
  renderer = createRenderer(canvas, maze);
  running = false;
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
  const state = s.solved ? `Solved in ${s.solvedAt} steps` : sim.pouring ? 'Pouring' : running ? 'Flowing' : 'Ready';
  status.textContent = `${state} · seed ${seed} · step ${s.steps} · drained ${s.drained.toFixed(2)}`;
  status.classList.toggle('solved', s.solved);
}

function frame(): void {
  if (running) stepSim(sim, params.stepsPerFrame);
  render();
  requestAnimationFrame(frame);
}

pourButton.addEventListener('click', () => setPouring(!sim.pouring));

createPanel();

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
  },
  reset(s = seed) {
    reset(s);
  },
};

reset(seed);
if (autostart) setPouring(true);
requestAnimationFrame(frame);
