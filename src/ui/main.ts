import { generateMaze } from '../maze/generate';
import { createRenderer } from '../render/draw';
import { createPanel } from './panel';

const DEFAULT_SEED = 42;
const DEFAULT_SIZE = 20;

/** Read an integer URL param, falling back when missing or invalid. */
function intParam(params: URLSearchParams, name: string, fallback: number): number {
  const v = Number.parseInt(params.get(name) ?? '', 10);
  return Number.isFinite(v) ? v : fallback;
}

const params = new URLSearchParams(location.search);
const seed = intParam(params, 'seed', DEFAULT_SEED);
const cols = Math.max(1, intParam(params, 'w', DEFAULT_SIZE));
const rows = Math.max(1, intParam(params, 'h', DEFAULT_SIZE));

// Write the effective values back so the URL always reproduces what's on screen.
params.set('seed', String(seed));
params.set('w', String(cols));
params.set('h', String(rows));
history.replaceState(null, '', `${location.pathname}?${params}`);

const maze = generateMaze(seed, { cols, rows });
const canvas = document.getElementById('view') as HTMLCanvasElement;
createRenderer(canvas, maze).draw();

createPanel();
