import { drawCheckerboard } from '../render/draw';
import { createPanel } from './panel';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;

canvas.width = 80;
canvas.height = 80;
const img = ctx.createImageData(canvas.width, canvas.height);
drawCheckerboard(img, 8);
ctx.putImageData(img, 0, 0);

createPanel();
