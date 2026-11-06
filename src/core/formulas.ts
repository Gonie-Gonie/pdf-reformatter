import { findColumnGutter } from './columns';
import { clampRect, finiteRect, union } from './geometry';
import type { Rect, SourcePage, SourceStructure, SourceText } from './model';
import type { PreservationRegion } from './preservation';
import { ownsPreservedText } from './preservation';

function encodedBracketRegions(page: SourcePage): PreservationRegion[] {
  const regions: PreservationRegion[] = [];
  for (const left of page.items.filter((item) => item.text.trim() === '"' && !item.artifact)) {
    const size = left.fontSize;
    const position = (item: SourceText) => item.baselineY ?? item.y + item.height / 2;
    for (const right of page.items.filter(
      (item) =>
        item.text.trim() === '#' &&
        !item.artifact &&
        item.fontName === left.fontName &&
        Math.abs(item.fontSize - size) <= size * 0.1 &&
        Math.abs(position(item) - position(left)) <= size * 0.2 &&
        item.x - left.x >= size * 2 &&
        item.x - left.x <= size * 16,
    )) {
      const ink = (item: SourceText) =>
        page.graphicRegions.find(
          (graphic) =>
            graphic.width <= size * 1.2 &&
            graphic.height >= size * 0.7 &&
            graphic.height <= size * 5 &&
            Math.abs(graphic.x - item.x) <= size * 0.6 &&
            graphic.y >= item.y - size * 0.2 &&
            graphic.y <= item.y + size * 3.5,
        );
      const leftInk = ink(left),
        rightInk = ink(right);
      if (!leftInk || !rightInk || Math.max(leftInk.height, rightInk.height) < size * 1.5) continue;
      const frame = union([leftInk, rightInk]);
      const members = page.items.filter(
        (item) =>
          !item.artifact &&
          item.text.trim().length > 0 &&
          item.text.length <= 25 &&
          item.width <= size * 10 &&
          item.x >= left.x &&
          item.x + item.width <= right.x + right.width + size * 0.5 &&
          item.y + item.height / 2 >= frame.y - size * 0.5 &&
          item.y + item.height / 2 <= frame.y + frame.height + size * 0.5,
      );
      if (
        members.length < 2 ||
        !members.some((item) => /[\p{Sm}¼\u0000-\u0008\u000e-\u001f]/u.test(item.text)) ||
        members.flatMap((item) => item.text.match(/\p{Ll}{3,}/gu) ?? []).length >= 3
      )
        continue;
      // A few legacy math fonts map scalable square brackets to quote/hash.
      // Paired same-font glyphs plus their vertical ink provide local proof;
      // neither character is rewritten or interpreted as math in normal prose.
      const hull = union([left, right, frame, ...members]);
      regions.push({
        rect: clampRect(
          { x: hull.x - 1, y: hull.y, width: hull.width + 2, height: hull.height + 1 },
          page.width,
          page.height,
        ),
        reason: '레거시 수식 괄호의 세로 도형과 내부 수식을 함께 보존',
        displayMath: true,
        boundedMath: true,
      });
    }
  }
  return regions;
}

function legacyDelimiterRegions(page: SourcePage): PreservationRegion[] {
  const baseline = (item: SourceText) => item.baselineY ?? item.y + item.height / 2;
  const compact = (item: SourceText, size: number) =>
    !item.artifact &&
    finiteRect(item) &&
    item.text.trim().length > 0 &&
    item.text.trim().length <= 30 &&
    item.text.trim().split(/\s+/u).length <= 2 &&
    item.width <= size * 12 &&
    item.fontSize <= size * 1.2;
  const regions: PreservationRegion[] = [];
  for (const left of page.items.filter((item) => item.text.trim() === 'À' && !item.artifact)) {
    const size = left.fontSize;
    for (const right of page.items.filter(
      (item) =>
        item.text.trim() === 'Á' &&
        compact(item, size) &&
        item.fontName === left.fontName &&
        Math.abs(item.fontSize - size) <= size * 0.1 &&
        Math.abs(baseline(item) - baseline(left)) <= size * 0.2 &&
        item.x - left.x >= size * 2 &&
        item.x - left.x <= size * 16,
    )) {
      const relation = page.items.find(
        (item) =>
          compact(item, size) &&
          /^(?:=|¼)$/u.test(item.text.trim()) &&
          item.x + item.width <= left.x + size * 0.2 &&
          left.x - item.x - item.width <= size * 2 &&
          baseline(item) - baseline(left) >= size * 0.2 &&
          baseline(item) - baseline(left) <= size,
      );
      if (!relation) continue;
      const row = page.items.filter(
        (item) =>
          compact(item, size) &&
          Math.abs(baseline(item) - baseline(relation)) <= size * 0.35 &&
          item.x >= relation.x - size * 6 &&
          item.x + item.width <= right.x + right.width + size * 12,
      );
      // These legacy code points represent tall delimiters only when they
      // enclose a mathematical row; ordinary accented Latin stays text.
      if (
        !row.some((item) => /[\p{Sm}−×]/u.test(item.text) && item !== relation) ||
        !row.some((item) => item.x > left.x && item.x + item.width < right.x + right.width)
      )
        continue;
      const hull = union([left, right, ...row]);
      const top = Math.min(left.y + left.height * 0.5, right.y + right.height * 0.5);
      regions.push({
        rect: clampRect(
          { x: hull.x - 2, y: top, width: hull.width + 4, height: hull.y + hull.height + 2 - top },
          page.width,
          page.height,
        ),
        reason: '레거시 글꼴의 수식 괄호와 해당 수식 줄을 함께 보존',
        displayMath: true,
        boundedMath: true,
      });
    }
  }
  return regions;
}

function fractionalRegions(page: SourcePage): PreservationRegion[] {
  const sizes = page.items
    .filter((item) => item.text.trim().length > 8)
    .map((item) => item.fontSize)
    .sort((a, b) => a - b);
  const size = sizes[Math.floor(sizes.length / 2)] ?? 10;
  const centerY = (item: Rect) => item.y + item.height / 2;
  const compact = (item: SourceText) =>
    !item.artifact &&
    finiteRect(item) &&
    item.text.trim().length > 0 &&
    item.text.trim().length <= 20 &&
    item.text.trim().split(/\s+/u).length <= 2 &&
    item.width <= size * 8 &&
    item.height <= size * 3;
  const regions: PreservationRegion[] = [];
  for (const graphic of page.graphicRegions) {
    if (
      !finiteRect(graphic) ||
      graphic.width < size * 1.5 ||
      graphic.width > Math.min(page.width * 0.5, size * 18) ||
      graphic.height < size * 1.8 ||
      graphic.height > size * 10
    )
      continue;
    const relations = page.items.filter(
      (item) =>
        !item.artifact &&
        /^(?:=|¼|≈|≃|≔)$/u.test(item.text.trim()) &&
        item.x + item.width <= graphic.x + size * 0.3 &&
        graphic.x - item.x - item.width <= size * 6 &&
        centerY(item) >= graphic.y &&
        centerY(item) <= graphic.y + graphic.height,
    );
    for (const relation of relations) {
      const label = page.items
        .filter(
          (item) =>
            !item.artifact &&
            finiteRect(item) &&
            item.text.trim().length <= 30 &&
            item.text.trim().split(/\s+/u).length <= 3 &&
            /\p{L}/u.test(item.text) &&
            !/[.!?:]$/u.test(item.text.trim()) &&
            item.width <= size * 12 &&
            item.x + item.width <= relation.x + 0.5 &&
            relation.x - item.x - item.width <= size * 2 &&
            Math.abs(centerY(item) - centerY(relation)) <= size * 0.6,
        )
        .sort((a, b) => b.x + b.width - a.x - a.width)[0];
      if (!label) continue;
      const inside = page.items.filter(
        (item) =>
          compact(item) &&
          item.x + item.width / 2 >= graphic.x &&
          item.x + item.width / 2 <= graphic.x + graphic.width &&
          centerY(item) >= graphic.y &&
          centerY(item) <= graphic.y + graphic.height,
      );
      if (inside.filter((item) => /[\p{N}\p{Sm}¼ðÞ]|^dt$/u.test(item.text)).length < 3) continue;
      const baselines = inside.map((item) => item.baselineY ?? centerY(item));
      if (Math.max(...baselines) - Math.min(...baselines) < size * 0.8) continue;
      const neighbors = page.items.filter(
        (item) =>
          compact(item) &&
          item.x + item.width / 2 >= label.x &&
          item.x + item.width / 2 <= graphic.x + graphic.width + size * 0.5 &&
          centerY(item) >= graphic.y - size * 1.8 &&
          centerY(item) <= graphic.y + graphic.height + size * 1.5,
      );
      const members = neighbors.filter((item) => {
        const row = page.items.filter(
          (other) =>
            !other.artifact &&
            Math.abs((other.baselineY ?? centerY(other)) - (item.baselineY ?? centerY(item))) <=
              size * 0.35 &&
            other.x < graphic.x + graphic.width &&
            other.x + other.width > label.x,
        );
        return (
          row.reduce((count, other) => count + (other.text.match(/\p{Ll}{4,}/gu)?.length ?? 0), 0) <
          3
        );
      });
      const owned = [label, relation, ...inside, ...members];
      const hull = union([graphic, ...owned]);
      let rect = clampRect(
        { x: hull.x - 2, y: hull.y - 2, width: hull.width + 4, height: hull.height + 4 },
        page.width,
        page.height,
      );
      // Font boxes for legacy integral glyphs can extend into preceding prose.
      // Use the available gap while retaining every intended mathematical run.
      for (const prose of page.items.filter(
        (item) =>
          !owned.includes(item) &&
          (item.text.match(/\p{Ll}{4,}/gu)?.length ?? 0) >= 3 &&
          item.x < rect.x + rect.width &&
          item.x + item.width > rect.x,
      )) {
        let candidate = rect;
        if (centerY(prose) < graphic.y && prose.y + prose.height > rect.y) {
          const top = prose.y + prose.height + 0.25;
          candidate = { ...rect, y: top, height: rect.y + rect.height - top };
        } else if (centerY(prose) > graphic.y + graphic.height && prose.y < rect.y + rect.height) {
          candidate = { ...rect, height: prose.y - 0.25 - rect.y };
        }
        if (
          finiteRect(candidate) &&
          candidate.y <= graphic.y &&
          candidate.y + candidate.height >= graphic.y + graphic.height &&
          owned.every((item) => ownsPreservedText(candidate, item))
        )
          rect = candidate;
      }
      regions.push({
        rect,
        reason: '분수 도형과 분리된 변수·적분 범위를 함께 보존',
        displayMath: true,
        boundedMath: true,
      });
    }
  }
  return regions;
}

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
  const regions: PreservationRegion[] = [
    ...fractionalRegions(page),
    ...legacyDelimiterRegions(page),
    ...encodedBracketRegions(page),
  ];
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
