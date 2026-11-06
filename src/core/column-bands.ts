import { findColumnGutter } from './columns';
import type { SourcePage, SourceText } from './model';

export interface ColumnBand {
  top: number;
  bottom: number;
  items: SourceText[];
  gutter?: number;
}

interface Row {
  items: SourceText[];
  center: number;
  size: number;
}

function rowsFor(items: SourceText[]): Row[] {
  const rows: Row[] = [];
  for (const item of [...items].sort(
    (a, b) => a.y + a.height / 2 - b.y - b.height / 2 || a.x - b.x,
  )) {
    if (item.artifact || item.preserve || !/\p{L}/u.test(item.text)) continue;
    const center = item.y + item.height / 2;
    const previous = rows.at(-1);
    if (
      previous &&
      Math.abs(previous.center - center) < Math.min(previous.size, item.fontSize) * 0.48
    )
      previous.items.push(item);
    else rows.push({ items: [item], center, size: item.fontSize });
  }
  // Operators and numeric fragments occupy real space even though they cannot
  // establish a prose row themselves. Ignoring them creates false gutters in
  // sentences with inline mathematics and can split that physical row in two.
  for (const item of items) {
    if (item.artifact || item.preserve || /\p{L}/u.test(item.text) || !item.text.trim()) continue;
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

function crossesGutter(row: Row, gutter: number): boolean {
  if (row.items.some((item) => item.x < gutter && item.x + item.width > gutter)) return true;
  const left = row.items.filter((item) => item.x < gutter);
  const right = row.items.filter((item) => item.x >= gutter);
  if (!left.length || !right.length) return false;
  const clearance =
    Math.min(...right.map((item) => item.x)) - Math.max(...left.map((item) => item.x + item.width));
  return clearance < Math.max(4, row.size * 0.8);
}

function supportsGutter(rows: Row[], index: number, gutter: number, width: number): boolean {
  const anchor = rows[index];
  const nearby = rows.filter((row) => Math.abs(row.center - anchor.center) <= anchor.size * 1.25);
  if (nearby.some((row) => crossesGutter(row, gutter))) return false;
  const selected = nearby.flatMap((row) => row.items);
  return [
    selected.filter((item) => item.x < gutter),
    selected.filter((item) => item.x >= gutter),
  ].every(
    (side) =>
      side.reduce((count, item) => count + (item.text.match(/\p{L}/gu)?.length ?? 0), 0) >= 8 &&
      Math.max(...side.map((item) => item.x + item.width)) -
        Math.min(...side.map((item) => item.x)) >=
        width * 0.08,
  );
}

/** Repeated local whitespace can change below a wide summary or beside a sidebar. */
function localTransitions(
  page: SourcePage,
  items: SourceText[],
): { top: number; gutter?: number }[] {
  const rows = rowsFor(items);
  const windowSize = 6;
  const pageGutter = findColumnGutter(items, page.width);
  const groups: { gutter: number; start: number; end: number; count: number }[] = [];
  for (let start = 0; start + windowSize <= rows.length; start++) {
    const window = rows.slice(start, start + windowSize);
    const selected = window.flatMap((row) => row.items);
    let gutter = findColumnGutter(selected, page.width);
    if (gutter === undefined) continue;
    // Indented headings can move a local estimate to the edge of the next
    // column. Reuse the stronger page estimate only while it remains a real
    // gap throughout this window; a summary or genuinely shifted column
    // crosses that gap and keeps its own local boundary.
    if (
      pageGutter !== undefined &&
      Math.abs(gutter - pageGutter) <= rows[start].size * 1.6 &&
      window.every((row) => !crossesGutter(row, pageGutter))
    )
      gutter = pageGutter;
    const previous = groups.at(-1);
    if (previous && Math.abs(previous.gutter - gutter) <= rows[start].size * 1.5) {
      previous.count++;
      previous.end = start + windowSize;
    } else groups.push({ gutter, start, end: start + windowSize, count: 1 });
  }
  const persistent = groups.filter((group) => group.count >= 2);
  const result: { top: number; gutter?: number }[] = [];
  for (const group of persistent) {
    if (
      result.length &&
      Math.abs(result.at(-1)!.gutter! - group.gutter) <= rows[group.start].size * 1.5
    )
      continue;
    // The first supporting window may still contain the end of the preceding
    // layout. Keep those wide prose rows intact and switch after the last one.
    let first = group.start;
    for (let index = group.start; index < group.start + windowSize; index++)
      if (crossesGutter(rows[index], group.gutter)) first = index + 1;
    while (first < group.end && !supportsGutter(rows, first, group.gutter, page.width)) first++;
    if (first >= rows.length || first >= group.end) continue;
    const top = Math.min(...rows[first].items.map((item) => item.y));
    if (!result.length) {
      const wideRows = rows.slice(0, first).filter((row) => crossesGutter(row, group.gutter));
      if (wideRows.length < 3) {
        result.push({ top: -Infinity, gutter: group.gutter });
        continue;
      }
      result.push({ top: -Infinity });
    }
    result.push({ top, gutter: group.gutter });
  }
  return result;
}

export function persistentColumnBands(
  page: SourcePage,
  items: SourceText[],
  cuts: number[],
  initial?: ColumnBand[],
): ColumnBand[] {
  if (initial)
    return initial.map((band) => {
      const selected = items.filter((item) => item.y >= band.top && item.y < band.bottom);
      return {
        top: band.top,
        bottom: band.bottom,
        items: selected,
        // Preserve transition boundaries, not whitespace belonging to a table
        // or chart whose labels have since been claimed by a source region.
        gutter: findColumnGutter(selected, page.width, page.graphicRegions),
      };
    });
  const boundaries = [-Infinity, ...cuts, Infinity];
  return boundaries.slice(0, -1).flatMap((top, index) => {
    const bottom = boundaries[index + 1];
    const selected = items.filter((item) => item.y >= top && item.y < bottom);
    const transitions = localTransitions(page, selected);
    if (!transitions.length)
      return [
        {
          top,
          bottom,
          items: selected,
          gutter: findColumnGutter(selected, page.width, page.graphicRegions),
        },
      ];
    return transitions.map((transition, transitionIndex) => {
      const bandTop = transitionIndex ? transition.top : top;
      const bandBottom = transitions[transitionIndex + 1]?.top ?? bottom;
      return {
        top: bandTop,
        bottom: bandBottom,
        items: selected.filter((item) => item.y >= bandTop && item.y < bandBottom),
        gutter: transition.gutter,
      };
    });
  });
}
