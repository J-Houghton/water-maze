import type { Maze } from '../maze/types';
import type { Sim } from '../sim/water';

type Rgb = readonly [number, number, number];

const WALL: Rgb = [0x8a, 0x8f, 0x99];
const DRY: Rgb = [0x1b, 0x1d, 0x22];
const WATER: Rgb = [0x3a, 0x8e, 0xe6];
const DEEP: Rgb = [0x12, 0x3c, 0x8c];

/** Rows below the maze showing water leaving the exit, one row per frame of history. */
const TAIL_ROWS = 16;

/** Pack an opaque colour for a little-endian Uint32 view of RGBA bytes. */
const pack = ([r, g, b]: Rgb) => ((0xff << 24) | (b << 16) | (g << 8) | r) >>> 0;
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];

/**
 * Water colour by mass / maxMass over [0, 2]: partly filled cells are paler,
 * full cells are WATER, compressed cells darken towards DEEP. Wet cells start
 * at 30% so thin films stay visible.
 */
const LUT_SIZE = 256;
const LUT_SCALE = (LUT_SIZE - 1) / 2;
const LUT = (() => {
  const lut = new Uint32Array(LUT_SIZE);
  for (let t = 0; t < LUT_SIZE; t++) {
    const m = t / LUT_SCALE;
    const base = mix(DRY, WATER, 0.3 + 0.7 * Math.min(1, m));
    lut[t] = pack(mix(base, DEEP, Math.min(1, Math.max(0, m - 1))));
  }
  return lut;
})();

export interface Renderer {
  draw(sim: Sim): void;
}

/**
 * One ImageData at sim-grid resolution, written through a Uint32 view and
 * blitted with a single putImageData. The canvas is scaled up by CSS.
 */
export function createRenderer(canvas: HTMLCanvasElement, maze: Maze): Renderer {
  const { w, h, solid } = maze;
  canvas.width = w;
  canvas.height = h + TAIL_ROWS;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(w, h + TAIL_ROWS);
  const px = new Uint32Array(img.data.buffer);
  const wall = pack(WALL);
  const dry = pack(DRY);

  /** Mass drained per exit cell per step, newest first; row k of the tail shows outflow[k]. */
  const outflow = new Float64Array(TAIL_ROWS);
  let seenSteps = 0;
  let seenDrained = 0;

  return {
    draw(sim) {
      const { mass, sinks } = sim;
      const { maxMass, minMass } = sim.params;
      const scale = LUT_SCALE / maxMass;
      for (let i = 0; i < w * h; i++) {
        const m = mass[i];
        px[i] = solid[i] ? wall : m < minMass ? dry : LUT[Math.min(LUT_SIZE - 1, (m * scale) | 0)];
      }

      // The tail scrolls one row per frame in which the sim advanced.
      const steps = sim.steps - seenSteps;
      if (steps > 0) {
        outflow.copyWithin(1, 0, TAIL_ROWS - 1);
        outflow[0] = (sim.drained - seenDrained) / (steps * Math.max(1, sinks.length));
      }
      seenSteps = sim.steps;
      seenDrained = sim.drained;
      px.fill(0, w * h);
      for (let k = 0; k < TAIL_ROWS; k++) {
        const m = outflow[k];
        if (m < minMass) continue;
        const colour = LUT[Math.min(LUT_SIZE - 1, (m * scale) | 0)];
        const row = (h + k) * w - (h - 1) * w;
        for (let s = 0; s < sinks.length; s++) px[row + sinks[s]] = colour;
      }

      ctx.putImageData(img, 0, 0);
    },
  };
}
