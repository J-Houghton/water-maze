import type { Maze } from '../maze/types';
import type { Sim } from '../sim/water';
import { createDroplets, updateDroplets, type DropletSources } from './droplets';
import { createField, DEPTH_CAP, ISO, prepareField, Thin } from './field';

type Rgb = readonly [number, number, number];

const WALL: Rgb = [0x8a, 0x8f, 0x99];
const DRY: Rgb = [0x1b, 0x1d, 0x22];
/** Open air below the maze, the page background. */
const BELOW: Rgb = [0x11, 0x11, 0x11];
const SHALLOW: Rgb = [0x5a, 0xb0, 0xf0];
const DEEP: Rgb = [0x0e, 0x2f, 0x6e];
const HIGHLIGHT: Rgb = [0xe2, 0xf4, 0xff];
const DROPLET: Rgb = [0xc4, 0xe6, 0xff];

/** Backing store on the maze's long side, whatever the devicePixelRatio. CSS scales the canvas. */
const OUTPUT_PX = 800;
/** Sim rows of open air drawn below the maze, where water leaving the exit sprays. */
const BELOW_ROWS = 16;
/** Half-width of the antialiased band at the water's edge, in pixels. */
const EDGE_AA_PX = 0.6;
/** Thin water never draws narrower or shallower than this, in pixels. */
const MIN_SHAPE_PX = 1.75;
/** Near-white band just inside the surface: width in pixels, so it looks alike at any maze size, and peak strength. */
const HIGHLIGHT_PX = 3.5;
const HIGHLIGHT_MAX = 0.7;
/** Droplet radius in cells, never below DROPLET_MIN_PX. */
const DROPLET_RADIUS = 0.28;
const DROPLET_MIN_PX = 1.5;
const DROPLET_ALPHA = 0.9;
/** Droplets advance once per sim step, but at most this many times per draw, so big jumps stay cheap. */
const MAX_DROPLET_UPDATES = 8;

/** Pack an opaque colour for a little-endian Uint32 view of RGBA bytes. */
const pack = (r: number, g: number, b: number) => ((0xff << 24) | (b << 16) | (g << 8) | r) >>> 0;
const packRgb = ([r, g, b]: Rgb) => pack(r, g, b);

/** Water colour by depth below the surface, shallow to deep over DEPTH_CAP cells, eased. */
const LUT_SIZE = 256;
const LUT_SCALE = (LUT_SIZE - 1) / DEPTH_CAP;
const LUT_R = new Uint8Array(LUT_SIZE);
const LUT_G = new Uint8Array(LUT_SIZE);
const LUT_B = new Uint8Array(LUT_SIZE);
const LUT = new Uint32Array(LUT_SIZE);
for (let k = 0; k < LUT_SIZE; k++) {
  const t = k / (LUT_SIZE - 1);
  const e = 1 - (1 - t) * (1 - t);
  LUT_R[k] = Math.round(SHALLOW[0] + (DEEP[0] - SHALLOW[0]) * e);
  LUT_G[k] = Math.round(SHALLOW[1] + (DEEP[1] - SHALLOW[1]) * e);
  LUT_B[k] = Math.round(SHALLOW[2] + (DEEP[2] - SHALLOW[2]) * e);
  LUT[k] = pack(LUT_R[k], LUT_G[k], LUT_B[k]);
}

export interface Renderer {
  /** Redraw, if the sim stepped (or its mass scale changed) since the last draw. */
  draw(sim: Sim): void;
  /** True while droplets are in flight. They move only as the sim steps. */
  readonly animating: boolean;
}

/** Per output column (or row): bilinear source cell and weight, nearest cell and the position within it. */
interface Axis {
  lo: Int32Array;
  t: Float32Array;
  near: Int32Array;
  local: Float32Array;
}

/** Sample n output pixels across `cells` cells, between cell centres: u = (p + 0.5) * cells / n - 0.5. */
function axis(n: number, cells: number): Axis {
  const a: Axis = {
    lo: new Int32Array(n),
    t: new Float32Array(n),
    near: new Int32Array(n),
    local: new Float32Array(n),
  };
  for (let p = 0; p < n; p++) {
    const c = ((p + 0.5) * cells) / n;
    const u = c - 0.5;
    const lo = Math.min(Math.max(0, Math.floor(u)), cells - 2);
    a.lo[p] = lo;
    a.t[p] = Math.min(1, Math.max(0, u - lo));
    a.near[p] = Math.min(cells - 1, Math.floor(c));
    a.local[p] = c - a.near[p];
  }
  return a;
}

/**
 * Smooth water from the sim's cells, written in JS into one ImageData of a
 * fixed size and blitted with a single putImageData:
 * - Iso-surface: the fill field, ghost-filled into walls, sampled bilinearly
 *   and thresholded at ISO, antialiased over ~1 px by the fill's gradient.
 * - Thin water the threshold would erase: falling streams as centred bands,
 *   floor films as bottom-aligned layers, their size following the fill.
 * - Colour by distance below the surface, with a highlight just inside it.
 * - Droplets splatted on top, and water spraying out below the exit.
 * Walls come from a crisp output-resolution mask, written once.
 */
export function createRenderer(canvas: HTMLCanvasElement, maze: Maze): Renderer {
  const { w, h, solid } = maze;
  const scale = OUTPUT_PX / Math.max(w, h);
  const OW = Math.round(w * scale);
  const MH = Math.round(h * scale);
  const OH = MH + Math.round(BELOW_ROWS * scale);
  canvas.width = OW;
  canvas.height = OH;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(OW, OH);
  const px = new Uint32Array(img.data.buffer);
  /** Pixels per cell on each axis (equal up to rounding). */
  const ppcX = OW / w;
  const ppcY = MH / h;

  const cols = axis(OW, w);
  const rows = axis(MH, h);
  /** First output column of each run between cell centres x and x + 1 (columns whose cols.lo is x). */
  const runStart = new Int32Array(w);
  for (let x = 0, p = 0; x < w; x++) {
    while (p < OW && cols.lo[p] < x) p++;
    runStart[x] = p;
  }

  // Walls never change: draw them once, mask them, and keep per row the open spans between them.
  const wallMask = new Uint8Array(OW * MH);
  const spanRows = new Int32Array(MH + 1);
  let spanCount = 0;
  for (let py = 0; py < MH; py++) {
    const row = rows.near[py] * w;
    for (let p = 0; p < OW; p++) {
      const wall = solid[row + cols.near[p]];
      wallMask[py * OW + p] = wall;
      if (!wall && (p === 0 || solid[row + cols.near[p - 1]])) spanCount++;
    }
  }
  const spans = new Int32Array(2 * spanCount);
  const wallColour = packRgb(WALL);
  for (let py = 0, s = 0; py < MH; py++) {
    spanRows[py] = s;
    const o = py * OW;
    for (let p = 0; p < OW; p++) {
      if (wallMask[o + p]) {
        px[o + p] = wallColour;
      } else if (p === 0 || wallMask[o + p - 1]) {
        spans[s++] = p;
        spans[s++] = p;
      }
      if (!wallMask[o + p]) spans[s - 1] = p + 1;
    }
    spanRows[py + 1] = s;
  }

  const field = createField(w, h, solid);
  const drops = createDroplets(field, BELOW_ROWS, maze.seed);
  const sources: DropletSources = { pourRate: 0, exitFlow: 0 };
  /** One output row's fill and depth, interpolated vertically per sim column. */
  const rowFill = new Float32Array(w);
  const rowDepth = new Float32Array(w);

  const dry = packRgb(DRY);
  const [DRY_R, DRY_G, DRY_B] = DRY;
  const [HL_R, HL_G, HL_B] = HIGHLIGHT;
  const below = packRgb(BELOW);
  /**
   * Fill values this close to ISO may lie within EDGE_AA_PX of the edge: the
   * bilinear fill changes by at most sqrt 2 per cell. Only those pixels pay
   * for the gradient that turns fill into a distance in pixels.
   */
  const nearEdge = (EDGE_AA_PX * Math.SQRT2) / ppcX;
  const edgeLo = ISO - nearEdge;
  const edgeHi = ISO + nearEdge;
  const highlightCells = HIGHLIGHT_PX / ppcX;
  const minWidth = MIN_SHAPE_PX / ppcX;
  const minHeight = MIN_SHAPE_PX / ppcY;
  const dropletRadius = Math.max(DROPLET_MIN_PX, DROPLET_RADIUS * ppcX);
  const [DR, DG, DB] = DROPLET;

  /** Iso-surface, thin shapes and depth colour for every open pixel of the maze. */
  function composite(): void {
    const { fill, depth, thin, edgeLo: shapeLo, edgeHi: shapeHi } = field;
    const { lo: colLo, t: colT, near: colNear, local: colLocal } = cols;
    const deepest = LUT[LUT_SIZE - 1];
    for (let py = 0; py < MH; py++) {
      const r0 = rows.lo[py] * w;
      const r1 = r0 + w;
      const ty = rows.t[py];
      for (let x = 0; x < w; x++) {
        const f = fill[r0 + x];
        rowFill[x] = f + (fill[r1 + x] - f) * ty;
        const d = depth[r0 + x];
        rowDepth[x] = d + (depth[r1 + x] - d) * ty;
      }
      const nearRow = rows.near[py] * w;
      const ly = rows.local[py];
      const o = py * OW;

      for (let si = spanRows[py]; si < spanRows[py + 1]; si += 2) {
        const spanEnd = spans[si + 1];
        let p = spans[si];
        // Walk the runs of pixels between two cell centres, classifying each run once.
        for (let x0 = colLo[p]; p < spanEnd; x0++) {
          const runEnd = Math.min(spanEnd, runStart[x0 + 1]);
          const fa = rowFill[x0];
          const fb = rowFill[x0 + 1];
          const da = rowDepth[x0];
          const db = rowDepth[x0 + 1];
          if (fa === 0 && fb === 0) {
            for (; p < runEnd; p++) px[o + p] = dry;
            continue;
          }
          if (fa >= edgeHi && fb >= edgeHi && da >= highlightCells && db >= highlightCells) {
            // Under water past the highlight: colour by depth alone.
            if (da >= DEPTH_CAP && db >= DEPTH_CAP) {
              for (; p < runEnd; p++) px[o + p] = deepest;
            } else {
              for (; p < runEnd; p++) {
                const d = da + (db - da) * colT[p];
                px[o + p] = LUT[d >= DEPTH_CAP ? LUT_SIZE - 1 : (d * LUT_SCALE) | 0];
              }
            }
            continue;
          }

          for (; p < runEnd; p++) {
            const tx = colT[p];
            const v = fa + (fb - fa) * tx;
            const d = da + (db - da) * tx;
            let alpha = 1;
            if (v < edgeHi) {
              alpha = 0;
              if (v > edgeLo) {
                // Antialias over a fixed width in pixels, however gently the fill crosses ISO.
                const gx = fb - fa;
                const sa = fill[r1 + x0] - fill[r0 + x0];
                const gy = sa + (fill[r1 + x0 + 1] - fill[r0 + x0 + 1] - sa) * tx;
                const g = Math.sqrt(gx * gx + gy * gy);
                const t = g > 0 ? 0.5 + ((v - ISO) * ppcX) / (g * 2 * EDGE_AA_PX) : v >= ISO ? 1 : 0;
                alpha = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
              }
              const n = nearRow + colNear[p];
              const cls = thin[n];
              if (cls !== Thin.None) {
                const shape = thinAlpha(cls, fill[n], shapeLo[n], shapeHi[n], colLocal[p], ly);
                if (shape > alpha) alpha = shape;
              }
              if (alpha <= 0) {
                px[o + p] = dry;
                continue;
              }
            }
            const li = d <= 0 ? 0 : d >= DEPTH_CAP ? LUT_SIZE - 1 : (d * LUT_SCALE) | 0;
            if (alpha === 1 && d >= highlightCells) {
              px[o + p] = LUT[li];
              continue;
            }
            // Edge, highlight or thin water: blend by hand.
            let r = LUT_R[li];
            let g = LUT_G[li];
            let b = LUT_B[li];
            if (d < highlightCells) {
              const s = 1 - (d <= 0 ? 0 : d / highlightCells);
              const rim = s * s * HIGHLIGHT_MAX;
              r += (HL_R - r) * rim;
              g += (HL_G - g) * rim;
              b += (HL_B - b) * rim;
            }
            px[o + p] = pack(
              (DRY_R + (r - DRY_R) * alpha) | 0,
              (DRY_G + (g - DRY_G) * alpha) | 0,
              (DRY_B + (b - DRY_B) * alpha) | 0,
            );
          }
        }
      }
    }
  }

  /**
   * Coverage of a thin cell's shape at local position (lx, ly) in [0, 1)^2.
   * The fill is interpolated from the cell centre toward its edge values, so
   * a stream's width and a film's height blend smoothly between cells.
   */
  function thinAlpha(k: number, m: number, lo: number, hi: number, lx: number, ly: number): number {
    let s: number;
    let f: number;
    if (k === Thin.Falling) {
      f = ly < 0.5 ? lo + (m - lo) * 2 * ly : m + (hi - m) * (2 * ly - 1);
      const half = 0.5 * Math.max(minWidth, Math.min(1, 1.5 * f));
      s = 0.5 - (Math.abs(lx - 0.5) - half) * ppcX;
    } else {
      f = lx < 0.5 ? lo + (m - lo) * 2 * lx : m + (hi - m) * (2 * lx - 1);
      const height = Math.max(minHeight, Math.min(1, f));
      s = 0.5 - (1 - ly - height) * ppcY;
    }
    if (s <= 0) return 0;
    // Very thin water is fainter as well as narrower.
    return Math.min(1, s) * Math.min(1, 0.35 + 4 * f);
  }

  /** Soft discs for droplets, over water, dry cells and the air below; never over walls. */
  function splatDroplets(): void {
    const reach = dropletRadius + 0.5;
    for (let k = 0; k < drops.capacity; k++) {
      if (!drops.life[k]) continue;
      const X = drops.x[k] * ppcX;
      const Y = drops.y[k] * ppcY;
      const xa = Math.max(0, Math.floor(X - reach));
      const xb = Math.min(OW - 1, Math.floor(X + reach));
      const ya = Math.max(0, Math.floor(Y - reach));
      const yb = Math.min(OH - 1, Math.floor(Y + reach));
      for (let py = ya; py <= yb; py++) {
        const dy = py + 0.5 - Y;
        for (let p = xa; p <= xb; p++) {
          const o = py * OW + p;
          if (py < MH && wallMask[o]) continue;
          const dx = p + 0.5 - X;
          let a = reach - Math.sqrt(dx * dx + dy * dy);
          if (a <= 0) continue;
          a = (a > 1 ? 1 : a) * DROPLET_ALPHA;
          const c = px[o];
          const r = c & 0xff;
          const g = (c >>> 8) & 0xff;
          const b = (c >>> 16) & 0xff;
          px[o] = pack((r + (DR - r) * a) | 0, (g + (DG - g) * a) | 0, (b + (DB - b) * a) | 0);
        }
      }
    }
  }

  let primed = false;
  let seenSteps = 0;
  let seenMaxMass = 0;
  let seenMinMass = 0;

  return {
    get animating() {
      return drops.alive > 0;
    },

    draw(sim) {
      const { maxMass, minMass, pourRate } = sim.params;
      const advanced = sim.steps - seenSteps;
      // Nothing moved since the last draw: the canvas already shows this frame.
      if (primed && advanced === 0 && maxMass === seenMaxMass && minMass === seenMinMass) return;
      primed = true;
      seenSteps = sim.steps;
      seenMaxMass = maxMass;
      seenMinMass = minMass;

      prepareField(field, sim.mass, maxMass, minMass, sim.lastDrained);
      // One droplet update per sim step; a negative count (a new sim) runs none.
      sources.pourRate = sim.pouring ? pourRate : 0;
      sources.exitFlow = sim.lastDrained;
      for (let k = Math.min(MAX_DROPLET_UPDATES, advanced); k > 0; k--) updateDroplets(drops, field, sources);

      composite();
      px.fill(below, OW * MH);
      splatDroplets();
      ctx.putImageData(img, 0, 0);
    },
  };
}
