function tintInk(data: Uint8ClampedArray, foreground: string, retainColor = false): void {
  const r = Number.parseInt(foreground.slice(1, 3), 16),
    g = Number.parseInt(foreground.slice(3, 5), 16),
    b = Number.parseInt(foreground.slice(5, 7), 16);
  for (let offset = 0; offset < data.length; offset += 4) {
    const low = Math.min(data[offset], data[offset + 1], data[offset + 2]);
    const high = Math.max(data[offset], data[offset + 1], data[offset + 2]);
    if (retainColor && high - low > 18) {
      // Recover colored ink composited on white, including its antialiased edge.
      const opacity = 1 - low / 255;
      for (let channel = 0; channel < 3; channel++)
        data[offset + channel] = Math.round((data[offset + channel] - low) / opacity);
      data[offset + 3] = Math.round(data[offset + 3] * opacity);
      continue;
    }
    const light = (data[offset] + data[offset + 1] + data[offset + 2]) / (255 * 3);
    data[offset + 3] = Math.round(data[offset + 3] * (1 - light));
    data[offset] = r;
    data[offset + 1] = g;
    data[offset + 2] = b;
  }
}

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
  tintInk(data, foreground);
  return true;
}

/** Only for identified TOC/index text crops; tight text bounds may touch the corners. */
export function recolorPreservedTextPixels(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  foreground: string,
): boolean {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    data.length !== width * height * 4 ||
    !/^#[\da-f]{6}$/iu.test(foreground)
  )
    return false;
  let visible = 0;
  let white = 0;
  let ink = 0;
  let darkInk = 0;
  let coloredInk = 0;
  const coloredRows = new Uint32Array(height);
  for (let offset = 0; offset < data.length; offset += 4) {
    if (!data[offset + 3]) continue;
    const r = data[offset],
      g = data[offset + 1],
      b = data[offset + 2];
    visible++;
    if (Math.min(r, g, b) >= 245) white++;
    else {
      ink++;
      if (Math.max(r, g, b) - Math.min(r, g, b) > 18) {
        coloredInk++;
        coloredRows[Math.floor(offset / (width * 4))]++;
      } else if ((r + g + b) / 3 <= 160) darkInk++;
    }
  }
  // A thin colored chapter rule can contain more pixels than the text itself.
  // Count its shape separately, rather than mistaking it for a colored panel.
  let ruleInk = 0;
  for (let first = 0; first < height; first++) {
    if (coloredRows[first] < width * 0.5) continue;
    let last = first + 1;
    while (last < height && coloredRows[last] >= width * 0.5) last++;
    if (last - first <= Math.max(1, Math.floor(height * 0.1)))
      for (let row = first; row < last; row++) ruleInk += coloredRows[row];
    first = last - 1;
  }
  const textInk = ink - ruleInk;
  // A white text page has sparse, dark strokes. Keep shaded panels and broad
  // grayscale imagery untouched, even if a source grouping was too generous.
  if (
    !visible ||
    !textInk ||
    white / visible < 0.35 ||
    darkInk / textInk < 0.45 ||
    (coloredInk - ruleInk) / textInk > 0.25 ||
    coloredInk / visible > 0.12
  )
    return false;
  tintInk(data, foreground, true);
  return true;
}
