import { clampRect, finiteRect, intersects, union } from './geometry';
import type { Rect, SourcePage, SourceText } from './model';
import { ownsPreservedText } from './preservation';
import type { PreservationRegion } from './preservation';

interface InlineLine {
  items: SourceText[];
  rect: Rect;
  text: string;
  fontSize: number;
}

const inlineReason = '수식 또는 첨자가 포함된 줄을 원문 모양으로 보존';

function center(line: InlineLine): number {
  const anchor = [...line.items].sort((a, b) => b.fontSize - a.fontSize)[0];
  return anchor
    ? (anchor.baselineY ?? anchor.y + anchor.height / 2)
    : line.rect.y + line.rect.height / 2;
}

function sameColumn(line: InlineLine, rect: Rect, size: number): boolean {
  const overlap =
    Math.min(line.rect.x + line.rect.width, rect.x + rect.width) - Math.max(line.rect.x, rect.x);
  return (
    overlap >= Math.min(line.rect.width, rect.width) * 0.65 &&
    (Math.abs(line.rect.x - rect.x) <= size * 2 ||
      Math.abs(line.rect.x + line.rect.width - rect.x - rect.width) <= size * 2)
  );
}

function proseOrInline(line: InlineLine, size: number): boolean {
  return (
    line.fontSize <= size * 1.15 &&
    !/^(?:fig(?:ure)?\.?|table|eq(?:uation)?\.?|그림|표|수식)\s*[\dIVX]/iu.test(line.text.trim()) &&
    !/^\d+(?:\.\d+)*\.?\s+\p{L}/u.test(line.text.trim()) &&
    !line.items.some(
      (item) =>
        item.artifact ||
        item.preserve ||
        Math.abs(item.rotation ?? 0) > 0.1 ||
        item.structureRoles?.some((role) =>
          /^(?:H[1-6]|Caption|Figure|Table|Note|FENote)$/u.test(role),
        ),
    ) &&
    !(line.text.length < 100 && line.items.some((item) => /bold|black|heavy/iu.test(item.fontName)))
  );
}

function inlineDrawing(graphic: Rect, items: SourceText[], size: number): boolean {
  return (
    graphic.width <= size * 3 &&
    graphic.height <= size * 2 &&
    items.some(
      (item) =>
        (/[√∫∑∏±×÷=]/u.test(item.text) || /math|symbol|cmsy|cmmi|cmex/iu.test(item.fontName)) &&
        intersects(graphic, item, size * 0.75),
    )
  );
}

/** Fractions can overlap adjacent prose glyph boxes; own those complete rows before cropping. */
export function protectInlineRows(
  page: SourcePage,
  inputLines: InlineLine[],
  seeds: PreservationRegion[],
): PreservationRegion[] {
  if (!finiteRect({ x: 0, y: 0, width: page.width, height: page.height })) return seeds;
  const lines = inputLines.filter((line) => finiteRect(line.rect) && line.items.length);
  return seeds.map((seed) => {
    if (seed.displayMath || seed.reason !== inlineReason || !finiteRect(seed.rect)) {
      return seed;
    }
    const initialItems = page.items.filter((item) => ownsPreservedText(seed.rect, item));
    if (!initialItems.length) return seed;
    const initialIds = new Set(initialItems.map((item) => item.id));
    const selected = lines.filter((line) => line.items.some((item) => initialIds.has(item.id)));
    const size = Math.max(...initialItems.map((item) => item.fontSize));
    if (!selected.length || selected.length > 4 || !Number.isFinite(size) || size <= 0) return seed;
    if (selected.some((line) => !proseOrInline(line, size))) return seed;
    const drawings = page.graphicRegions.filter(
      (graphic) => finiteRect(graphic) && intersects(seed.rect, graphic),
    );
    if (drawings.some((graphic) => !inlineDrawing(graphic, initialItems, size))) return seed;
    const originalColumn = union(selected.map((line) => line.rect));
    const owned = new Set(initialIds);
    let expanded = false;
    for (let pass = 0; pass < 4; pass++) {
      const ownedItems = page.items.filter((item) => owned.has(item.id));
      const hull = union([...ownedItems, ...drawings]);
      const first = Math.min(...selected.map(center));
      const last = Math.max(...selected.map(center));
      const nearby = lines.filter(
        (line) => !selected.includes(line) && sameColumn(line, originalColumn, size),
      );
      const before = nearby
        .filter((line) => center(line) < first)
        .sort((a, b) => center(b) - center(a))[0];
      const after = nearby
        .filter((line) => center(line) > last)
        .sort((a, b) => center(a) - center(b))[0];
      const additions = [before, after].filter((line): line is InlineLine => {
        if (!line) return false;
        const glyphs = line.items.filter((item) => !owned.has(item.id));
        return glyphs.some(
          (item) =>
            Math.min(item.y + item.height, hull.y + hull.height) - Math.max(item.y, hull.y) > 0.01,
        );
      });
      if (!additions.length) break;
      if (
        selected.length + additions.length > 4 ||
        additions.some(
          (line) =>
            !proseOrInline(line, size) ||
            page.graphicRegions.some(
              (graphic) =>
                finiteRect(graphic) &&
                intersects(line.rect, graphic) &&
                !inlineDrawing(graphic, [...ownedItems, ...line.items], size),
            ),
        )
      ) {
        return seed;
      }
      for (const line of additions) {
        selected.push(line);
        line.items.forEach((item) => owned.add(item.id));
        for (const graphic of page.graphicRegions)
          if (finiteRect(graphic) && intersects(line.rect, graphic) && !drawings.includes(graphic))
            drawings.push(graphic);
      }
      expanded = true;
    }
    if (!expanded) return selected.length > 1 ? { ...seed, inlineRows: true } : seed;
    const ownedItems = page.items.filter((item) => owned.has(item.id));
    const hull = union([...ownedItems, ...drawings]);
    const rect = clampRect(
      { x: hull.x - 2, y: hull.y - 2, width: hull.width + 4, height: hull.height + 4 },
      page.width,
      page.height,
    );
    if (
      page.graphicRegions.some(
        (graphic) =>
          finiteRect(graphic) &&
          intersects(rect, graphic) &&
          !inlineDrawing(graphic, ownedItems, size),
      )
    )
      return seed;
    return { ...seed, rect, inlineRows: true };
  });
}
