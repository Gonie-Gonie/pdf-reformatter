import { clampRect, finiteRect, intersects, union } from '../../core/geometry';
import type { Rect, SourcePage, SourceText } from '../../core/model';

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

export function mergeGraphicRegions(regions: Rect[], source: SourcePage, gap = 14): Rect[] {
  const merged = regions.filter(finiteRect).map((rect) => ({ ...rect }));
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let index = 0; index < merged.length; index++) {
      const a = merged[index];
      for (let other = index + 1; other < merged.length; other++) {
        const b = merged[other];
        if (!intersects(a, b, gap) || textBetween(a, b, source)) continue;
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
    const x0 = Math.max(0, Math.floor((item.x - 2) * scale));
    const x1 = Math.min(width, Math.ceil((item.x + item.width + 2) * scale));
    const y0 = Math.max(0, Math.floor((item.y - 2) * scale));
    const y1 = Math.min(height, Math.ceil((item.y + item.height + 2) * scale));
    for (let y = y0; y < y1; y++) mask.fill(1, y * width + x0, y * width + x1);
  }
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
