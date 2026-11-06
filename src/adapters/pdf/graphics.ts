import { clampRect, finiteRect, intersects, union } from '../../core/geometry';
import type { Rect, SourcePage, SourceText } from '../../core/model';

/** Enlarged period glyphs are sometimes used as the data markers of a vector plot. */
export function drawingTextIds(source: SourcePage): Set<string> {
  const body = source.items
    .filter((item) => item.text.trim().split(/\s+/u).length >= 4)
    .map((item) => item.fontSize)
    .sort((a, b) => a - b);
  const size = body[Math.floor(body.length / 2)] ?? 10;
  const dots = source.items.filter(
    (item) =>
      !item.artifact &&
      finiteRect(item) &&
      /^[.\s·•]+$/u.test(item.text) &&
      /[.·•]/u.test(item.text) &&
      item.fontSize >= size * 2.4,
  );
  return new Set(
    dots
      .filter((item) => {
        const matching = dots.filter(
          (other) =>
            other.fontName === item.fontName &&
            Math.abs(other.fontSize - item.fontSize) <= item.fontSize * 0.15,
        );
        if (matching.length < 4) return false;
        const rect = union(matching);
        return Math.max(rect.width, rect.height) >= item.fontSize * 1.5;
      })
      .map((item) => item.id),
  );
}

function proseRun(item: SourceText, source: SourcePage): boolean {
  return (
    item.text.trim().length >= 20 && /\p{L}/u.test(item.text) && item.width >= source.width * 0.25
  );
}

/** A nearby drawing must not grow through an intervening paragraph or caption. */
function textBetween(a: Rect, b: Rect, source: SourcePage): boolean {
  const combined = union([a, b]);
  return source.items.some((item) => {
    if (!proseRun(item, source) || !intersects(combined, item)) return false;
    const center = { x: item.x + item.width / 2, y: item.y + item.height / 2 };
    const contains = (rect: Rect) =>
      center.x >= rect.x &&
      center.x <= rect.x + rect.width &&
      center.y >= rect.y &&
      center.y <= rect.y + rect.height;
    if (contains(a) || contains(b)) return false;
    const verticalGap = Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height);
    if (verticalGap > 0) {
      const top = Math.min(a.y + a.height, b.y + b.height);
      const bottom = Math.max(a.y, b.y);
      if (item.y < bottom && item.y + item.height > top) return true;
    }
    const horizontalGap = Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width);
    if (horizontalGap > 0) {
      const left = Math.min(a.x + a.width, b.x + b.width);
      const right = Math.max(a.x, b.x);
      return item.x < right && item.x + item.width > left;
    }
    return false;
  });
}

function headerArtwork(rect: Rect, source: SourcePage): boolean {
  if (
    rect.y < 0 ||
    rect.y + rect.height > source.height * 0.1 ||
    Math.max(rect.width, rect.height) > 32 ||
    Math.min(rect.width, rect.height) < 2
  )
    return false;
  const row = source.items.filter(
    (item) =>
      item.y >= 0 &&
      item.y + item.height <= source.height * 0.1 &&
      Math.abs(item.y + item.height / 2 - rect.y - rect.height / 2) <=
        Math.max(item.fontSize * 0.8, rect.height * 0.5),
  );
  const folios = row.filter(
    (item) =>
      /^\d{1,5}$/u.test(item.text.trim()) &&
      item.width <= item.fontSize * 4 &&
      (item.x + item.width / 2 < source.width * 0.25 ||
        item.x + item.width / 2 > source.width * 0.75),
  );
  return (
    folios.length > 0 &&
    row.some(
      (item) =>
        (item.text.match(/\p{L}/gu)?.length ?? 0) >= 4 &&
        !/^(?:fig(?:ure)?\.?|table|그림|표)\s*\d/iu.test(item.text.trim()) &&
        Math.max(item.x - rect.x - rect.width, rect.x - item.x - item.width, 0) <=
          item.fontSize * 3,
    )
  );
}

function headerRule(rect: Rect, source: SourcePage): boolean {
  if (
    rect.height > 6 ||
    rect.width < source.width * 0.35 ||
    rect.y + rect.height > source.height * 0.12
  )
    return false;
  const row = source.items.filter(
    (item) =>
      item.y >= 0 &&
      item.y + item.height <= rect.y + 2 &&
      rect.y - item.y - item.height <= item.fontSize * 2,
  );
  return (
    row.some(
      (item) =>
        /^\d{1,5}$/u.test(item.text.trim()) &&
        (item.x < source.width * 0.25 || item.x > source.width * 0.75),
    ) &&
    row.some(
      (item) =>
        (item.text.match(/\p{L}/gu)?.length ?? 0) >= 4 &&
        !/^(?:fig(?:ure)?\.?|table|그림|표)\s*\d/iu.test(item.text.trim()),
    )
  );
}

export function captionBounds(source: SourcePage): Rect[] {
  const baseline = (item: SourceText) => item.baselineY ?? item.y + item.height / 2;
  return source.items
    .filter((item) => /^(?:fig(?:ure)?\.?|그림)\s*\d+(?:\.\d+)*/iu.test(item.text.trim()))
    .map((start) => {
      const row = source.items
        .filter(
          (item) =>
            !item.preserve &&
            item.x >= start.x &&
            Math.abs(baseline(item) - baseline(start)) <= start.fontSize * 0.4 &&
            Math.abs(item.fontSize - start.fontSize) <= start.fontSize * 0.2,
        )
        .sort((a, b) => a.x - b.x);
      const members = [start];
      for (const item of row) {
        if (item === start) continue;
        if (/^(?:fig(?:ure)?\.?|그림)\s*\d/iu.test(item.text.trim())) break;
        const previous = members[members.length - 1];
        if (item.x - previous.x - previous.width > start.fontSize * 3) break;
        members.push(item);
      }
      return union(members);
    });
}

export function separatelyCaptioned(a: Rect, b: Rect, captions: Rect[]): boolean {
  const [left, right] = [a, b].sort((one, other) => one.x - other.x);
  if (left.x + left.width > right.x || !intersects(left, right, 20)) return false;
  const under = (graphic: Rect, caption: Rect) =>
    caption.y >= graphic.y + graphic.height - caption.height * 0.4 &&
    caption.y <= graphic.y + graphic.height + caption.height * 6 &&
    graphic.x + graphic.width / 2 >= caption.x &&
    graphic.x + graphic.width / 2 <= caption.x + caption.width;
  return captions.some(
    (one) =>
      under(left, one) &&
      captions.some((two) => two !== one && one.x + one.width < two.x && under(right, two)),
  );
}

function maskColoredMarginFrames(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  scale: number,
  source: SourcePage,
  mask: Uint8Array,
): void {
  const colored = (x: number, y: number) => {
    const index = (y * width + x) * 4;
    const maximum = Math.max(pixels[index], pixels[index + 1], pixels[index + 2]);
    const minimum = Math.min(pixels[index], pixels[index + 1], pixels[index + 2]);
    return pixels[index + 3] > 100 && maximum >= 120 && maximum - minimum >= 70;
  };
  const columns: Rect[] = [];
  const minimumLength = source.height * scale * 0.45;
  for (let x = 0; x < width; x++) {
    let start = -1;
    for (let y = 0; y <= height; y++) {
      if (y < height && colored(x, y)) {
        if (start < 0) start = y;
      } else if (start >= 0) {
        if (y - start >= minimumLength) columns.push({ x, y: start, width: 1, height: y - start });
        start = -1;
      }
    }
  }
  const frames: Rect[] = [];
  for (const column of columns) {
    const previous = frames[frames.length - 1];
    if (
      previous &&
      column.x === previous.x + previous.width &&
      Math.min(previous.y + previous.height, column.y + column.height) -
        Math.max(previous.y, column.y) >=
        Math.min(previous.height, column.height) * 0.9
    )
      frames[frames.length - 1] = union([previous, column]);
    else frames.push(column);
  }
  for (const frame of frames) {
    if (frame.width > scale * 3) continue;
    const right = (frame.x + frame.width) / scale;
    const prose = source.items.filter(
      (item) =>
        !item.preserve &&
        item.text.trim().split(/\s+/u).length >= 6 &&
        item.width >= source.width * 0.35 &&
        item.x >= right &&
        item.x - right <= item.fontSize * 3 &&
        item.y >= frame.y / scale &&
        item.y + item.height <= (frame.y + frame.height) / scale,
    );
    const baselines = new Set(prose.map((item) => Math.round((item.baselineY ?? item.y) / 3)));
    if (baselines.size < 4) continue;
    // Colored tables and plot frames have long horizontal edges at both ends.
    const crossbars: number[] = [];
    const x = Math.floor(frame.x + frame.width / 2);
    for (let y = frame.y; y < frame.y + frame.height; y++) {
      if (!colored(x, y)) continue;
      let left = x;
      let edge = x;
      while (left > 0 && colored(left - 1, y)) left--;
      while (edge + 1 < width && colored(edge + 1, y)) edge++;
      if (
        edge - left >= source.width * scale * 0.3 &&
        !crossbars.some((value) => y - value < scale * 3)
      )
        crossbars.push(y);
    }
    if (crossbars.length >= 2) continue;
    for (let y = frame.y; y < frame.y + frame.height; y++)
      for (let column = frame.x; column < frame.x + frame.width; column++)
        if (colored(column, y)) mask[y * width + column] = 1;
  }
}

export function mergeGraphicRegions(regions: Rect[], source: SourcePage, gap = 14): Rect[] {
  const merged = regions.filter(finiteRect).map((rect) => ({ ...rect }));
  const captions = captionBounds(source);
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let index = 0; index < merged.length; index++) {
      const a = merged[index];
      for (let other = index + 1; other < merged.length; other++) {
        const b = merged[other];
        if (
          !intersects(a, b, gap) ||
          textBetween(a, b, source) ||
          separatelyCaptioned(a, b, captions)
        )
          continue;
        // A publisher's tiny running logo can sit only a few points above a figure.
        // Keep it separate so the original image bounds and running-header pass can agree.
        if (
          !intersects(a, b) &&
          (headerArtwork(a, source) || headerRule(a, source)) !==
            (headerArtwork(b, source) || headerRule(b, source))
        )
          continue;
        merged[index] = union([a, b]);
        merged.splice(other, 1);
        changed = true;
        break outer;
      }
    }
  }
  return merged;
}

/** Cell connectivity is only a search index; bounds come from actual visible ink pixels. */
export function detectGraphicRegions(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  scale: number,
  source: SourcePage,
): Rect[] {
  const mask = new Uint8Array(width * height);
  for (const item of source.items) {
    if (item.preserve) continue;
    let top = item.y;
    // PDF.js can combine a superscript digit and following ordinary prose in one
    // small-font run. Match its neighboring body baseline only for the ink mask.
    if (/^\d{1,3}\s+\p{L}/u.test(item.text) && item.text.trim().split(/\s+/u).length >= 4) {
      const baseline = item.baselineY ?? item.y + item.fontSize * 0.8;
      const neighbor = source.items
        .filter(
          (other) =>
            other !== item &&
            !other.preserve &&
            other.fontName === item.fontName &&
            item.fontSize < other.fontSize * 0.86 &&
            other.fontSize < item.fontSize * 1.7 &&
            Math.abs((other.baselineY ?? other.y + other.fontSize * 0.8) - baseline) <=
              other.fontSize * 0.4 &&
            Math.max(item.x - other.x - other.width, other.x - item.x - item.width, 0) <=
              other.fontSize * 2,
        )
        .sort(
          (a, b) =>
            Math.abs((a.baselineY ?? a.y + a.fontSize * 0.8) - baseline) -
            Math.abs((b.baselineY ?? b.y + b.fontSize * 0.8) - baseline),
        )[0];
      if (neighbor) top = Math.min(top, neighbor.y);
    }
    const x0 = Math.max(0, Math.floor((item.x - 2) * scale));
    const x1 = Math.min(width, Math.ceil((item.x + item.width + 2) * scale));
    const y0 = Math.max(0, Math.floor((top - 2) * scale));
    const y1 = Math.min(height, Math.ceil((item.y + item.height + 2) * scale));
    for (let y = y0; y < y1; y++) mask.fill(1, y * width + x0, y * width + x1);
  }
  maskColoredMarginFrames(pixels, width, height, scale, source, mask);
  const cell = Math.max(2, Math.round(3 * scale));
  const columns = Math.ceil(width / cell),
    rows = Math.ceil(height / cell);
  const counts = new Uint16Array(columns * rows);
  const left = new Uint32Array(counts.length).fill(width),
    top = new Uint32Array(counts.length).fill(height);
  const right = new Uint32Array(counts.length),
    bottom = new Uint32Array(counts.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const point = y * width + x,
        color = point * 4;
      if (
        mask[point] ||
        pixels[color + 3] <= 50 ||
        Math.min(pixels[color], pixels[color + 1], pixels[color + 2]) >= 218
      )
        continue;
      const index = Math.floor(y / cell) * columns + Math.floor(x / cell);
      counts[index]++;
      left[index] = Math.min(left[index], x);
      top[index] = Math.min(top[index], y);
      right[index] = Math.max(right[index], x);
      bottom[index] = Math.max(bottom[index], y);
    }
  }
  const regions: Rect[] = [];
  const seen = new Uint8Array(counts.length);
  for (let start = 0; start < counts.length; start++) {
    if (seen[start] || !counts[start]) continue;
    const queue = [start];
    seen[start] = 1;
    let minX = width,
      minY = height,
      maxX = 0,
      maxY = 0,
      ink = 0;
    for (let head = 0; head < queue.length; head++) {
      const index = queue[head],
        x = index % columns,
        y = Math.floor(index / columns);
      minX = Math.min(minX, left[index]);
      minY = Math.min(minY, top[index]);
      maxX = Math.max(maxX, right[index]);
      maxY = Math.max(maxY, bottom[index]);
      ink += counts[index];
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx,
            ny = y + dy,
            next = ny * columns + nx;
          if (nx < 0 || nx >= columns || ny < 0 || ny >= rows || seen[next] || !counts[next])
            continue;
          seen[next] = 1;
          queue.push(next);
        }
    }
    if (ink < 8) continue;
    regions.push(
      clampRect(
        {
          x: minX / scale - 2,
          y: minY / scale - 2,
          width: (maxX - minX + 1) / scale + 4,
          height: (maxY - minY + 1) / scale + 4,
        },
        source.width,
        source.height,
      ),
    );
  }
  return mergeGraphicRegions(regions, source);
}
