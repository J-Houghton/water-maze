import type { Maze } from '../maze/types';

/** Pack an opaque colour for a little-endian Uint32 view of RGBA bytes. */
const rgb = (r: number, g: number, b: number) => (0xff << 24) | (b << 16) | (g << 8) | r;

const WALL = rgb(0x8a, 0x8f, 0x99);
const DRY = rgb(0x1b, 0x1d, 0x22);

export interface Renderer {
  draw(): void;
}

/**
 * One ImageData at sim-grid resolution, written through a Uint32 view and
 * blitted with a single putImageData. The canvas is scaled up by CSS.
 */
export function createRenderer(canvas: HTMLCanvasElement, maze: Maze): Renderer {
  canvas.width = maze.w;
  canvas.height = maze.h;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(maze.w, maze.h);
  const px = new Uint32Array(img.data.buffer);
  const { solid } = maze;

  return {
    draw() {
      for (let i = 0; i < solid.length; i++) px[i] = solid[i] ? WALL : DRY;
      ctx.putImageData(img, 0, 0);
    },
  };
}
