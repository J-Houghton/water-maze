export interface SimParams {
  /** Mass of a full, uncompressed cell. */
  maxMass: number;
  /** Extra mass a cell can hold per cell of water above it (pressure). */
  maxCompress: number;
  /** Below this a cell counts as dry. Mass is never deleted, only ignored. */
  minMass: number;
  /** Flows above this are halved each step, which smooths the motion. */
  minFlow: number;
  /** Cap on mass moved to one neighbour per step. */
  maxSpeed: number;
  /** Mass added at the entrance per step while pouring. */
  pourRate: number;
  /** Sim steps per rendered frame. Speed only; does not change the physics. */
  stepsPerFrame: number;
}

export const DEFAULT_PARAMS: Readonly<SimParams> = {
  maxMass: 1.0,
  maxCompress: 0.02,
  minMass: 0.0001,
  // CLAUDE.md lists 0.01; 0 is needed for the settle invariant. See Decisions there.
  minFlow: 0,
  maxSpeed: 1.0,
  pourRate: 0.5,
  stepsPerFrame: 4,
};

export interface ParamRange {
  min: number;
  max: number;
  step: number;
}

/** Slider ranges for the debug panel. */
export const PARAM_RANGES: Readonly<Record<keyof SimParams, ParamRange>> = {
  maxMass: { min: 0.1, max: 4, step: 0.01 },
  maxCompress: { min: 0, max: 0.2, step: 0.001 },
  minMass: { min: 0, max: 0.01, step: 0.00001 },
  minFlow: { min: 0, max: 0.1, step: 0.001 },
  maxSpeed: { min: 0.05, max: 4, step: 0.01 },
  pourRate: { min: 0, max: 4, step: 0.01 },
  stepsPerFrame: { min: 1, max: 8, step: 1 },
};
