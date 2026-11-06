import { findColumnGutter } from './columns';
import { clampRect, finiteRect, union } from './geometry';
import type { Rect, SourcePage, SourceStructure, SourceText } from './model';
import type { PreservationRegion } from './preservation';

function formulaDepth(group: SourceStructure, groups: Map<string, SourceStructure>): number {
  let depth = 0;
  let parent = group.parentId ? groups.get(group.parentId) : undefined;
  const visited = new Set<string>();
  while (parent && !visited.has(parent.id)) {
    visited.add(parent.id);
    if (parent.role === 'Formula') depth++;
    parent = parent.parentId ? groups.get(parent.parentId) : undefined;
  }
  return depth;
}

function inlineFormula(
  page: SourcePage,
  members: SourceText[],
  rect: Rect,
  gutter: number | undefined,
  formulaIds: Set<string>,
): boolean {
  const size = Math.max(...members.map((item) => item.fontSize));
  const anchors = members.filter((item) => item.fontSize >= size * 0.85);
  const prose = page.items.filter((item) => {
    if (
      formulaIds.has(item.id) ||
      item.artifact ||
      item.preserve ||
      !/\p{L}/u.test(item.text) ||
      /math|symbol|cmsy|cmmi|cmex|msam|msbm/iu.test(item.fontName) ||
      item.fontSize < size * 0.7 ||
      item.fontSize > size * 1.5
    )
      return false;
    if (
      gutter !== undefined &&
      ((rect.x + rect.width <= gutter && item.x >= gutter) ||
        (item.x + item.width <= gutter && rect.x >= gutter))
    )
      return false;
    const beside =
      item.x + item.width <= rect.x + size * 0.25 || item.x >= rect.x + rect.width - size * 0.25;
    if (!beside) return false;
    return anchors.some((anchor) => {
      if (anchor.baselineY !== undefined && item.baselineY !== undefined)
        return Math.abs(anchor.baselineY - item.baselineY) <= Math.max(size, item.fontSize) * 0.35;
      const overlap =
        Math.min(anchor.y + anchor.height, item.y + item.height) - Math.max(anchor.y, item.y);
      return (
        overlap >= Math.min(anchor.height, item.height) * 0.45 &&
        Math.abs(anchor.y + anchor.height / 2 - item.y - item.height / 2) <= size * 0.45
      );
    });
  });
  const near = prose.filter(
    (item) => Math.max(rect.x - item.x - item.width, item.x - rect.x - rect.width, 0) <= size * 1.5,
  );
  const sameBaseline = (a: SourceText, b: SourceText) =>
    a.baselineY !== undefined && b.baselineY !== undefined
      ? Math.abs(a.baselineY - b.baselineY) <= size * 0.35
      : Math.abs(a.y + a.height / 2 - b.y - b.height / 2) <= size * 0.45;
  // PDF producers may emit a word one glyph at a time. Count the nearby prose
  // collectively instead of requiring a whole word in one extracted text run.
  for (const seed of near) {
    const pending = near.filter((item) => sameBaseline(seed, item));
    const connected = new Set<SourceText>();
    let letters = 0;
    while (pending.length) {
      const item = pending.pop()!;
      if (connected.has(item)) continue;
      connected.add(item);
      letters += (item.text.match(/\p{L}/gu) ?? []).length;
      if (letters >= 3) return true;
      for (const neighbor of prose) {
        if (connected.has(neighbor) || !sameBaseline(seed, neighbor)) continue;
        const gap = Math.max(
          item.x - neighbor.x - neighbor.width,
          neighbor.x - item.x - item.width,
          0,
        );
        if (gap <= size * 0.75) pending.push(neighbor);
      }
    }
  }
  return false;
}

/** Formula tags identify a compound, but do not supply a trustworthy crop or mathematical source. */
export function formulaRegions(page: SourcePage): PreservationRegion[] {
  if (
    !Number.isFinite(page.width) ||
    !Number.isFinite(page.height) ||
    page.width <= 0 ||
    page.height <= 0
  )
    return [];
  const groups = new Map((page.structure ?? []).map((group) => [group.id, group]));
  const items = new Map(page.items.map((item) => [item.id, item]));
  const claimed = new Set<string>();
  const regions: PreservationRegion[] = [];
  const formulas = (page.structure ?? [])
    .filter((group) => group.role === 'Formula')
    .sort((a, b) => formulaDepth(a, groups) - formulaDepth(b, groups) || a.order - b.order);
  if (!formulas.length) return regions;
  const formulaIds = new Set(formulas.flatMap((group) => group.sourceIds));
  const gutter = findColumnGutter(page.items, page.width, page.graphicRegions);
  for (const group of formulas) {
    const ids = [...new Set(group.sourceIds)];
    if (!ids.length || ids.some((id) => !items.has(id) || claimed.has(id))) continue;
    const members = ids.map((id) => items.get(id)!);
    if (
      members.some(
        (item) =>
          item.artifact ||
          ![item.x, item.y, item.width, item.height, item.fontSize].every(Number.isFinite) ||
          item.width < 0 ||
          item.height <= 0 ||
          item.fontSize <= 0,
      )
    )
      continue;
    const hull = union(members);
    if (!finiteRect(hull) || inlineFormula(page, members, hull, gutter, formulaIds)) continue;
    const rect = clampRect(
      { x: hull.x - 2, y: hull.y - 2, width: hull.width + 4, height: hull.height + 4 },
      page.width,
      page.height,
    );
    if (!finiteRect(rect)) continue;
    regions.push({
      rect,
      reason: '수식의 문자·첨자·분수선을 함께 원문 모양으로 보존',
      displayMath: true,
    });
    ids.forEach((id) => claimed.add(id));
  }
  return regions;
}
