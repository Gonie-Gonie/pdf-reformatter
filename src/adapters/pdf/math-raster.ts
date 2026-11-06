/** A monochrome formula inherits the selected ink; colored mathematical annotations stay intact. */
export function recolorMathPixels(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  foreground: string,
): boolean {
  if (!width || !height || data.length !== width * height * 4) return false;
  const corners = [0, (width - 1) * 4, (height - 1) * width * 4, (width * height - 1) * 4];
  if (corners.some((offset) => Math.min(data[offset], data[offset + 1], data[offset + 2]) < 245))
    return false;
  for (let offset = 0; offset < data.length; offset += 4) {
    const r = data[offset],
      g = data[offset + 1],
      b = data[offset + 2];
    if (data[offset + 3] && Math.max(r, g, b) - Math.min(r, g, b) > 18) return false;
  }
  const r = Number.parseInt(foreground.slice(1, 3), 16),
    g = Number.parseInt(foreground.slice(3, 5), 16),
    b = Number.parseInt(foreground.slice(5, 7), 16);
  for (let offset = 0; offset < data.length; offset += 4) {
    const light = (data[offset] + data[offset + 1] + data[offset + 2]) / (255 * 3);
    data[offset + 3] = Math.round(data[offset + 3] * (1 - light));
    data[offset] = r;
    data[offset + 1] = g;
    data[offset + 2] = b;
  }
  return true;
}
