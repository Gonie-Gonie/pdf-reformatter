import type { Rect, SourceText } from './model';

interface Row {
  items: SourceText[];
  center: number;
  size: number;
}

interface Gap {
  left: number;
  right: number;
  row: number;
  leftRows: number[];
  rightRows: number[];
}

function letterCount(text: string): number {
  return (text.match(/\p{L}/gu) ?? []).length;
}

function bodySize(items: readonly SourceText[]): number {
  const weighted = items
    .map((item) => ({ size: item.fontSize, weight: Math.min(100, letterCount(item.text)) }))
    .filter((entry) => entry.weight >= 4 && entry.size > 0 && Number.isFinite(entry.size))
    .sort((a, b) => a.size - b.size);
  const middle = weighted.reduce((sum, entry) => sum + entry.weight, 0) / 2;
  let cumulative = 0;
  for (const entry of weighted) {
    cumulative += entry.weight;
    if (cumulative >= middle) return entry.size;
  }
  return 12;
}

/** Baseline proximity, rather than overlapping font boxes, keeps close leading separate. */
function proseRows(items: readonly SourceText[], size: number): Row[] {
  const rows: Row[] = [];
  const candidates = items
    .filter(
      (item) =>
        !item.artifact &&
        !item.preserve &&
        !item.structureRoles?.some((role) => ['Table', 'TR', 'TH', 'TD'].includes(role)) &&
        [item.x, item.y, item.width, item.height, item.fontSize].every(Number.isFinite) &&
        item.width > 0 &&
        item.height > 0 &&
        item.fontSize >= size * 0.75 &&
        item.text.trim().length > 0,
    )
    .sort((a, b) => a.y + a.height / 2 - b.y - b.height / 2 || a.x - b.x);
  for (const item of candidates.filter((entry) => letterCount(entry.text) > 0)) {
    const center = item.y + item.height / 2;
    const previous = rows.at(-1);
    if (
      previous &&
      Math.abs(previous.center - center) <= Math.min(previous.size, item.fontSize) * 0.48
    ) {
      previous.items.push(item);
    } else {
      rows.push({ items: [item], center, size: item.fontSize });
    }
  }
  // A reference label occupies the column edge but must not create its own column.
  for (const item of candidates.filter((entry) => letterCount(entry.text) === 0)) {
    const center = item.y + item.height / 2;
    const nearest = rows.reduce<Row | undefined>(
      (best, row) =>
        !best || Math.abs(row.center - center) < Math.abs(best.center - center) ? row : best,
      undefined,
    );
    if (nearest && Math.abs(nearest.center - center) <= Math.max(nearest.size, item.fontSize) * 0.7)
      nearest.items.push(item);
  }
  return rows;
}

function credibleSide(items: SourceText[], width: number): boolean {
  if (!items.length) return false;
  const letters = items.reduce((sum, item) => sum + letterCount(item.text), 0);
  const left = Math.min(...items.map((item) => item.x));
  const right = Math.max(...items.map((item) => item.x + item.width));
  return letters >= 8 && right - left >= width * 0.08;
}

function credibleRows(
  items: SourceText[],
  rowByItem: Map<string, number>,
  width: number,
): number[] {
  const grouped = new Map<number, SourceText[]>();
  for (const item of items) {
    const index = rowByItem.get(item.id)!;
    const row = grouped.get(index) ?? [];
    row.push(item);
    grouped.set(index, row);
  }
  return [...grouped].flatMap(([index, row]) => (credibleSide(row, width) ? [index] : []));
}

function gutterFromRows(
  rows: Row[],
  rowByItem: Map<string, number>,
  size: number,
  pageWidth: number,
): number | undefined {
  const minimumGap = Math.max(4, size * 0.8);
  const gaps: Gap[] = [];
  for (let index = 0; index < rows.length; index++) {
    const ordered = [...rows[index].items].sort((a, b) => a.x - b.x);
    const whitespace: number[] = [];
    let occupied = -Infinity;
    for (const item of ordered) {
      const gap = item.x - occupied;
      if (Number.isFinite(gap) && gap > 0.5) whitespace.push(gap);
      occupied = Math.max(occupied, item.x + item.width);
    }
    whitespace.sort((a, b) => a - b);
    const usualGap = whitespace.length >= 4 ? whitespace[Math.floor(whitespace.length / 2)] : 0;
    let right = -Infinity;
    for (let next = 0; next < ordered.length; next++) {
      const item = ordered[next];
      if (
        item.x - right >= minimumGap &&
        item.x - right >= usualGap * 1.8 &&
        credibleSide(ordered.slice(0, next), pageWidth) &&
        credibleSide(ordered.slice(next), pageWidth)
      ) {
        const left = Math.max(right, pageWidth * 0.22);
        const end = Math.min(item.x, pageWidth * 0.8);
        if (end - left >= minimumGap)
          gaps.push({
            left,
            right: end,
            row: index,
            leftRows: credibleRows(ordered.slice(0, next), rowByItem, pageWidth),
            rightRows: credibleRows(ordered.slice(next), rowByItem, pageWidth),
          });
      }
      right = Math.max(right, item.x + item.width);
    }
  }
  const candidates = [...new Set(gaps.map((gap) => (gap.left + gap.right) / 2))];
  let best: number | undefined;
  let bestScore = 0;
  for (const candidate of candidates) {
    const supporting = gaps.filter(
      (gap) => candidate - gap.left >= minimumGap / 4 && gap.right - candidate >= minimumGap / 4,
    );
    let band: Gap[] = [];
    const consider = () => {
      if (band.length < 2) return;
      if (
        new Set(band.flatMap((gap) => gap.leftRows)).size < 2 ||
        new Set(band.flatMap((gap) => gap.rightRows)).size < 2
      )
        return;
      const commonLeft = Math.max(...band.map((gap) => gap.left));
      const commonRight = Math.min(...band.map((gap) => gap.right));
      const clearance = commonRight - commonLeft;
      if (clearance < minimumGap) return;
      // Two adjacent justified-word gaps are not sufficient evidence of columns.
      if (band.length === 2 && clearance < size * 1.5) return;
      const height = rows[band.at(-1)!.row].center - rows[band[0].row].center;
      const score = band.length * size + height * 0.15 + Math.min(clearance, size * 4);
      if (score > bestScore) {
        // Short final lines make the left edge ragged; the next column's start is stable.
        best = commonRight - Math.min(clearance / 2, size);
        bestScore = score;
      }
    };
    for (const gap of supporting) {
      const previous = band.at(-1);
      const separated =
        previous &&
        (rows[gap.row].center - rows[previous.row].center > size * 4 ||
          rows
            .slice(previous.row + 1, gap.row)
            .some((row) =>
              row.items.some((item) => item.x < candidate && item.x + item.width > candidate),
            ));
      if (separated) {
        consider();
        band = [];
      }
      band.push(gap);
    }
    consider();
  }
  return best;
}

/** A substantial drawing can supply the otherwise text-free side of a column. */
function graphicGutter(
  rows: Row[],
  graphics: readonly Rect[],
  pageWidth: number,
  size: number,
): number | undefined {
  let best: number | undefined;
  let bestScore = 0;
  const minimumGap = Math.max(4, size * 0.8);
  for (const graphic of graphics) {
    if (
      ![graphic.x, graphic.y, graphic.width, graphic.height].every(Number.isFinite) ||
      graphic.width < pageWidth * 0.2 ||
      graphic.width > pageWidth * 0.48 ||
      graphic.height < size * 4
    )
      continue;
    const overlapping = rows.filter(
      (row) => row.center >= graphic.y && row.center <= graphic.y + graphic.height,
    );
    for (const side of ['left', 'right'] as const) {
      const prose = overlapping.flatMap((row) => {
        const items = row.items.filter((item) =>
          side === 'left'
            ? item.x + item.width <= graphic.x - minimumGap
            : item.x >= graphic.x + graphic.width + minimumGap,
        );
        if (items.reduce((sum, item) => sum + letterCount(item.text), 0) < 12) return [];
        const left = Math.min(...items.map((item) => item.x));
        const right = Math.max(...items.map((item) => item.x + item.width));
        return right - left >= pageWidth * 0.2 ? [{ left, right, center: row.center }] : [];
      });
      if (prose.length < 3) continue;
      const left =
        side === 'left' ? Math.max(...prose.map((row) => row.right)) : graphic.x + graphic.width;
      const right = side === 'left' ? graphic.x : Math.min(...prose.map((row) => row.left));
      const clearance = right - left;
      if (clearance < minimumGap) continue;
      const candidate = right - Math.min(clearance / 2, size);
      if (
        candidate < pageWidth * 0.22 ||
        candidate > pageWidth * 0.8 ||
        overlapping.some((row) =>
          row.items.some(
            (item) =>
              letterCount(item.text) > 0 && item.x < candidate && item.x + item.width > candidate,
          ),
        )
      )
        continue;
      const height =
        Math.max(...prose.map((row) => row.center)) - Math.min(...prose.map((row) => row.center));
      if (height < size * 1.2) continue;
      const score = prose.length * size + height * 0.15 + Math.min(clearance, size * 4);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
  }
  return best;
}

/**
 * Find persistent whitespace between prose on both sides of a page.
 * Internal PDF run starts may be arbitrarily dense and never define a column edge.
 */
export function findColumnGutter(
  items: readonly SourceText[],
  pageWidth: number,
  graphics: readonly Rect[] = [],
): number | undefined {
  if (!Number.isFinite(pageWidth) || pageWidth <= 0 || !items.length) return undefined;
  const size = bodySize(items);
  const rows = proseRows(items, size);
  const rowByItem = new Map(
    rows.flatMap((row, index) => row.items.map((item) => [item.id, index] as const)),
  );
  const aligned = gutterFromRows(rows, rowByItem, size, pageWidth);
  if (aligned !== undefined) return aligned;
  // Independently flowing columns need not share baselines. Nearby-row windows
  // prove the same empty strip, while provenance still requires two rows per side.
  const windows = rows.map((row) => ({
    ...row,
    items: rows
      .filter((other) => Math.abs(other.center - row.center) <= size * 1.25)
      .flatMap((other) => other.items),
  }));
  const staggered = gutterFromRows(windows, rowByItem, size, pageWidth);
  if (staggered === undefined) return graphicGutter(rows, graphics, pageWidth, size);
  // Offset rows must not invent a cut through an existing prose column merely
  // because its neighbouring table has several aligned text and numeric cells.
  const crossedProseRows = rows.filter((row) =>
    row.items.some(
      (item) =>
        item.width >= pageWidth * 0.2 &&
        item.width <= pageWidth * 0.65 &&
        letterCount(item.text) >= 15 &&
        item.x < staggered &&
        item.x + item.width > staggered,
    ),
  );
  return crossedProseRows.length >= 2 ? graphicGutter(rows, graphics, pageWidth, size) : staggered;
}
