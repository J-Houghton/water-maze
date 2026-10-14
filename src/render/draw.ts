/** Fill an RGBA ImageData buffer with a checkerboard of `size`-pixel squares. */
export function drawCheckerboard(img: ImageData, size: number): void {
  const { width: w, height: h, data } = img;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = ((((x / size) | 0) + ((y / size) | 0)) & 1) === 0 ? 0x30 : 0xa0;
      const o = (y * w + x) * 4;
      data[o] = v;
      data[o + 1] = v;
      data[o + 2] = v;
      data[o + 3] = 255;
    }
  }
}
