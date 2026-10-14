/**
 * Render-side fields derived from the sim's mass grid, at sim resolution.
 * Pure and DOM-free: typed arrays in, typed arrays out, allocated once in
 * createField. draw.ts samples these per output pixel.
 */

/** Fill level of the drawn water surface: the iso line is where the interpolated fill crosses it. */
export const ISO = 0.5;
/** Cells filled above this but below ISO are thin water, drawn as sub-cell shapes. */
export const THIN_MIN = 0.0005;
/** A thin cell over a cell fuller than this rests on water rather than falling. */
const FALL_ONTO_MAX = 0.95;
/** Depth in cells at which water reaches the deepest colour. Sealed pockets, with no air to measure from, sit here. */
export const DEPTH_CAP = 14;
/** Distance seed for cells the chamfer has not reached yet. */
const FAR = 1e9;
const DIAGONAL = Math.SQRT2;

/** Thin-water class per cell. */
export const Thin = { None: 0, Falling: 1, Film: 2 } as const;

/** What a cell is for the iso-surface: wall, air (open, fill < ISO) or water. */
const WALL = 0;
const AIR = 1;
const WATER = 2;

export interface WaterField {
  readonly w: number;
  readonly h: number;
  readonly solid: Uint8Array;
  /** Open cells on the bottom row: the exit gap. */
  readonly exits: Int32Array;
  /** clamp(mass / maxMass, 0, 1), 0 when dry. Walls hold the max of their open neighbours (ghost fill). */
  readonly fill: Float32Array;
  /**
   * Signed distance in cells from the water surface (the ISO line): positive
   * through water, negative in air down to -1, capped at DEPTH_CAP. Walls are
   * not air, so water against a wall stays deep. Ghost-filled like `fill`.
   */
  readonly depth: Float32Array;
  /** WALL, AIR or WATER per cell. */
  readonly kind: Uint8Array;
  /** Thin class per cell, see Thin. */
  readonly thin: Uint8Array;
  /**
   * For thin cells, the fill the shape should have at the cell's two edges
   * along it (top and bottom for falling, left and right for film), so widths
   * and heights blend into the neighbours instead of stepping per cell.
   */
  readonly edgeLo: Float32Array;
  readonly edgeHi: Float32Array;
  /** Wall cells next to open ones, and per cell (ghostStart[k] to ghostStart[k + 1]) the open cells it copies. */
  readonly ghostCells: Int32Array;
  readonly ghostStart: Int32Array;
  readonly ghostSources: Int32Array;
  /** Thin cells, thinCount valid. */
  readonly thinCells: Int32Array;
  thinCount: number;
  /** Falling cells whose stream lands on water or a floor, impactCount valid. */
  readonly impacts: Int32Array;
  impactCount: number;
}

export function createField(w: number, h: number, solid: Uint8Array): WaterField {
  const exits: number[] = [];
  for (let x = 0; x < w; x++) if (!solid[(h - 1) * w + x]) exits.push((h - 1) * w + x);
  const n = w * h;
  return {
    w,
    h,
    solid,
    exits: Int32Array.from(exits),
    fill: new Float32Array(n),
    depth: new Float32Array(n),
    kind: new Uint8Array(n),
    thin: new Uint8Array(n),
    edgeLo: new Float32Array(n),
    edgeHi: new Float32Array(n),
    ...ghostSourcesOf(w, h, solid),
    thinCells: new Int32Array(n),
    thinCount: 0,
    impacts: new Int32Array(n),
    impactCount: 0,
  };
}

/**
 * Rebuild every field from the sim's mass. `exitFlow` is the mass drained on
 * the latest step: while it is positive the exit row, which the sim empties
 * every step, is drawn holding the water passing through it.
 */
export function prepareField(
  field: WaterField,
  mass: Float64Array,
  maxMass: number,
  minMass: number,
  exitFlow: number,
): void {
  const { w, h, solid, fill, kind, exits } = field;
  const inv = 1 / maxMass;
  for (let i = 0; i < fill.length; i++) {
    const m = mass[i];
    let f = m * inv;
    if (f > 1) f = 1;
    if (m < minMass || !(f > 0)) f = 0;
    // Branch-free on walls, which are scattered too finely to predict.
    const open = 1 - solid[i];
    fill[i] = f * open;
    // Classify on the stored (float32) value: a fill just under ISO can round
    // up to it, and water and air holding equal fills would divide by zero.
    kind[i] = open * (fill[i] >= ISO ? WATER : AIR);
  }
  if (exitFlow > 0 && h > 1) {
    for (let k = 0; k < exits.length; k++) {
      const i = exits[k];
      fill[i] = fill[i - w];
      kind[i] = fill[i] >= ISO ? WATER : AIR;
    }
  }

  classifyThin(field);
  surfaceDistance(field);
  ghostFill(field, fill);
  ghostFill(field, field.depth);
}

/**
 * Give every wall cell the max of its open neighbours, so the bilinear field
 * runs flat into walls and water meets them flush. Uses the sources found
 * once in createField. Walls with no open neighbour keep what they hold,
 * which prepareField leaves at 0.
 */
export function ghostFill(field: WaterField, a: Float32Array): void {
  const { ghostCells, ghostStart, ghostSources } = field;
  for (let k = 0; k < ghostCells.length; k++) {
    const end = ghostStart[k + 1];
    let s = ghostStart[k];
    let v = a[ghostSources[s]];
    for (s++; s < end; s++) if (a[ghostSources[s]] > v) v = a[ghostSources[s]];
    a[ghostCells[k]] = v;
  }
}

/**
 * Wall cells next to open cells and where they take ghost values from: their
 * open 4-neighbours, or at inner corners with none, their open diagonals.
 */
function ghostSourcesOf(w: number, h: number, solid: Uint8Array) {
  const sides = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  const corners = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
  const cells: number[] = [];
  const start: number[] = [0];
  const sources: number[] = [];
  const add = (x: number, y: number) => {
    if (x >= 0 && x < w && y >= 0 && y < h && !solid[y * w + x]) sources.push(y * w + x);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!solid[y * w + x]) continue;
      const before = sources.length;
      for (const [dx, dy] of sides) add(x + dx, y + dy);
      if (sources.length === before) for (const [dx, dy] of corners) add(x + dx, y + dy);
      if (sources.length === before) continue;
      cells.push(y * w + x);
      start.push(sources.length);
    }
  }
  return {
    ghostCells: Int32Array.from(cells),
    ghostStart: Int32Array.from(start),
    ghostSources: Int32Array.from(sources),
  };
}

/**
 * Signed distance to the water surface, into field.depth. Water cells on the
 * interface are seeded with the sub-cell distance from their centre to where
 * the bilinear fill crosses ISO toward an air neighbour, so the field is ~0
 * exactly on the drawn edge whatever the surface cell's fill. Distance then
 * spreads through water only, by a two-pass chamfer with weights 1 and
 * sqrt 2: walls and air hold FAR meanwhile, so they never pass it on. Air
 * gets the same crossing distance, negated, at most one cell.
 */
function surfaceDistance(field: WaterField): void {
  const { w, h, kind, depth } = field;

  // Forward pass: seed interface cells and relax from the cells already visited.
  for (let y = 0; y < h; y++) {
    const innerRow = y > 0 && y < h - 1;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (kind[i] !== WATER) {
        depth[i] = FAR;
        continue;
      }
      let v = FAR;
      if (innerRow && x > 0 && x < w - 1) {
        // Most water has no air around it: one test skips the seed.
        const around =
          kind[i - 1] | kind[i + 1] | kind[i - w] | kind[i + w] |
          kind[i - w - 1] | kind[i - w + 1] | kind[i + w - 1] | kind[i + w + 1];
        if (around & AIR) v = surfaceSeed(field, i, x, y);
        let c = depth[i - 1] + 1;
        if (c < v) v = c;
        c = depth[i - w] + 1;
        if (c < v) v = c;
        c = depth[i - w - 1] + DIAGONAL;
        if (c < v) v = c;
        c = depth[i - w + 1] + DIAGONAL;
        if (c < v) v = c;
      } else {
        v = surfaceSeed(field, i, x, y);
        if (x > 0 && depth[i - 1] + 1 < v) v = depth[i - 1] + 1;
        if (y > 0) {
          if (depth[i - w] + 1 < v) v = depth[i - w] + 1;
          if (x > 0 && depth[i - w - 1] + DIAGONAL < v) v = depth[i - w - 1] + DIAGONAL;
          if (x + 1 < w && depth[i - w + 1] + DIAGONAL < v) v = depth[i - w + 1] + DIAGONAL;
        }
      }
      depth[i] = v;
    }
  }

  // Backward pass over water. Walls and air must read FAR until no water
  // cell will read them, so each row's are finished one row behind.
  for (let y = h - 1; y >= 0; y--) {
    const innerRow = y < h - 1;
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (kind[i] !== WATER) continue;
      let v = depth[i];
      if (innerRow && x > 0 && x < w - 1) {
        let c = depth[i + 1] + 1;
        if (c < v) v = c;
        c = depth[i + w] + 1;
        if (c < v) v = c;
        c = depth[i + w + 1] + DIAGONAL;
        if (c < v) v = c;
        c = depth[i + w - 1] + DIAGONAL;
        if (c < v) v = c;
      } else {
        if (x + 1 < w && depth[i + 1] + 1 < v) v = depth[i + 1] + 1;
        if (y + 1 < h) {
          if (depth[i + w] + 1 < v) v = depth[i + w] + 1;
          if (x + 1 < w && depth[i + w + 1] + DIAGONAL < v) v = depth[i + w + 1] + DIAGONAL;
          if (x > 0 && depth[i + w - 1] + DIAGONAL < v) v = depth[i + w - 1] + DIAGONAL;
        }
      }
      // Anything relaxed from a capped value is past the cap too, so capping now is safe.
      depth[i] = v > DEPTH_CAP ? DEPTH_CAP : v;
    }
    if (y + 1 < h) finishRow(field, y + 1);
  }
  finishRow(field, 0);
}

/**
 * Sub-cell distance from water cell i's centre to the nearest ISO crossing
 * toward an air neighbour, or FAR. Beyond the grid is open air: the entrance
 * and exit gaps open onto it, so water standing in them has a surface there.
 */
function surfaceSeed(field: WaterField, i: number, x: number, y: number): number {
  const { w, h, fill, kind } = field;
  const l = x > 0;
  const r = x + 1 < w;
  const u = y > 0;
  const d = y + 1 < h;
  const v = fill[i];
  const over = v - ISO;
  let best = l && r && u && d ? FAR : over / v;
  if (l && kind[i - 1] === AIR) best = Math.min(best, over / (v - fill[i - 1]));
  if (r && kind[i + 1] === AIR) best = Math.min(best, over / (v - fill[i + 1]));
  if (u && kind[i - w] === AIR) best = Math.min(best, over / (v - fill[i - w]));
  if (d && kind[i + w] === AIR) best = Math.min(best, over / (v - fill[i + w]));
  if (u && l && kind[i - w - 1] === AIR) best = Math.min(best, (DIAGONAL * over) / (v - fill[i - w - 1]));
  if (u && r && kind[i - w + 1] === AIR) best = Math.min(best, (DIAGONAL * over) / (v - fill[i - w + 1]));
  if (d && l && kind[i + w - 1] === AIR) best = Math.min(best, (DIAGONAL * over) / (v - fill[i + w - 1]));
  if (d && r && kind[i + w + 1] === AIR) best = Math.min(best, (DIAGONAL * over) / (v - fill[i + w + 1]));
  return best;
}

/** Final depth for row y's walls (0) and air (minus the distance to the nearest crossing into water, at most 1). */
function finishRow(field: WaterField, y: number): void {
  const { w, h, fill, kind, depth } = field;
  const innerRow = y > 0 && y < h - 1;
  for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const k = kind[i];
    if (k === WATER) continue;
    if (k === WALL) {
      depth[i] = 0;
      continue;
    }
    if (innerRow && x > 0 && x < w - 1 && !((kind[i - 1] | kind[i + 1] | kind[i - w] | kind[i + w]) & WATER)) {
      depth[i] = -1;
      continue;
    }
    const v = fill[i];
    const under = v - ISO;
    let best = -1;
    if (x > 0 && kind[i - 1] === WATER) best = Math.max(best, under / (fill[i - 1] - v));
    if (x + 1 < w && kind[i + 1] === WATER) best = Math.max(best, under / (fill[i + 1] - v));
    if (y > 0 && kind[i - w] === WATER) best = Math.max(best, under / (fill[i - w] - v));
    if (y + 1 < h && kind[i + w] === WATER) best = Math.max(best, under / (fill[i + w] - v));
    depth[i] = best;
  }
}

/**
 * Classify thin cells (THIN_MIN < fill < ISO), which the iso threshold would
 * erase, and collect stream impact points:
 * - Falling: the cell below is open and not full, the cell is part of a
 *   vertical run of thin cells, and neither side neighbour is water. The run
 *   check stops single thin cells on sloped fronts drawing as hair-like ticks.
 * - Film: thin water lying on a solid floor.
 * Then fills edgeLo/edgeHi for every thin cell.
 */
function classifyThin(field: WaterField): void {
  const { w, h, solid, fill, kind, thin, edgeLo, edgeHi, thinCells, impacts } = field;
  thin.fill(Thin.None);
  let count = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const v = fill[i];
      if (kind[i] !== AIR || v <= THIN_MIN) continue;
      // Below the bottom row is open air: water there is leaving the maze.
      const below = y + 1 < h ? i + w : -1;
      if (below >= 0 && solid[below]) {
        thin[i] = Thin.Film;
        thinCells[count++] = i;
        continue;
      }
      const fb = below >= 0 ? fill[below] : 0;
      if (fb >= FALL_ONTO_MAX) continue;
      const runUp = y > 0 && kind[i - w] === AIR && fill[i - w] > THIN_MIN;
      const runDown = below >= 0 && kind[below] === AIR && fb > THIN_MIN;
      const besideWater = (x > 0 && kind[i - 1] === WATER) || (x + 1 < w && kind[i + 1] === WATER);
      if ((runUp || runDown) && !besideWater) {
        thin[i] = Thin.Falling;
        thinCells[count++] = i;
      }
    }
  }

  // A run partner that sits beside water was not classified, leaving a lone
  // falling cell: a 1-cell tick on a sloped front. Drop those too.
  let kept = 0;
  for (let k = 0; k < count; k++) {
    const i = thinCells[k];
    if (
      thin[i] === Thin.Falling &&
      !(i >= w && thin[i - w] === Thin.Falling) &&
      !(i + w < thin.length && thin[i + w] === Thin.Falling)
    ) {
      thin[i] = Thin.None;
    } else {
      thinCells[kept++] = i;
    }
  }
  field.thinCount = kept;

  let impactCount = 0;
  for (let k = 0; k < kept; k++) {
    const i = thinCells[k];
    const x = i % w;
    const y = (i - x) / w;
    if (thin[i] === Thin.Falling) {
      edgeLo[i] = edgeFill(field, i, y > 0 ? i - w : -1, Thin.Falling);
      edgeHi[i] = edgeFill(field, i, y + 1 < h ? i + w : -1, Thin.Falling);
      if (y + 1 < h && landsBelow(field, i + w)) impacts[impactCount++] = i;
    } else {
      edgeLo[i] = edgeFill(field, i, x > 0 ? i - 1 : -1, Thin.Film);
      edgeHi[i] = edgeFill(field, i, x + 1 < w ? i + 1 : -1, Thin.Film);
    }
  }
  field.impactCount = impactCount;
}

/**
 * Shape fill at the edge shared by thin cell i and neighbour j (-1 = off the
 * grid): halfway to a neighbour of the same class or to water, flush against
 * a wall or the grid edge, and tapering to half where the shape ends in air.
 */
function edgeFill(field: WaterField, i: number, j: number, k: number): number {
  const m = field.fill[i];
  if (j < 0 || field.solid[j]) return m;
  if (field.thin[j] === k || field.kind[j] === WATER) return (m + field.fill[j]) / 2;
  return m / 2;
}

/** Does a falling stream whose lowest cell sits above cell j land on something here? */
function landsBelow(field: WaterField, j: number): boolean {
  const { w, solid, fill, kind, thin } = field;
  if (thin[j] === Thin.Falling) return false;
  if (solid[j] || thin[j] === Thin.Film || kind[j] === WATER) return true;
  // A thin, unclassified cell resting just above water or a floor.
  if (fill[j] <= THIN_MIN || j + w >= fill.length) return false;
  return solid[j + w] === 1 || kind[j + w] === WATER;
}
