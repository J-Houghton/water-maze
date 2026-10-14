import GUI from 'lil-gui';
import { PARAM_RANGES, type SimParams } from '../sim/params';

export interface MazeControls {
  seed: number;
  /** Same seed, empty water. */
  reset(): void;
  /** Next seed, new maze. */
  regenerate(): void;
}

export interface Panel {
  /** Re-read every bound value, after something other than the panel changed it. */
  refresh(): void;
}

/** Debug panel: one slider per SimParams field, bound live, plus maze controls. */
export function createPanel(params: SimParams, maze: MazeControls): Panel {
  const gui = new GUI({ title: 'Sim' });

  const water = gui.addFolder('Water');
  for (const key of Object.keys(PARAM_RANGES) as (keyof SimParams)[]) {
    const { min, max, step } = PARAM_RANGES[key];
    water.add(params, key, min, max, step);
  }

  const mazeFolder = gui.addFolder('Maze');
  mazeFolder
    .add(maze, 'seed')
    .step(1)
    .onFinishChange(() => maze.reset());
  mazeFolder.add(maze, 'reset').name('Reset');
  mazeFolder.add(maze, 'regenerate').name('Regenerate');

  return {
    refresh() {
      for (const c of gui.controllersRecursive()) c.updateDisplay();
    },
  };
}
