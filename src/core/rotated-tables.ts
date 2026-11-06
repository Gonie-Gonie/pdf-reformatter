import { clampRect, finiteRect, intersects, union } from './geometry';
import type { Rect, SourcePage, SourceText } from './model';
import type { PreservationRegion } from './preservation';

function upright(rect: Rect, page: SourcePage, rotation: number): Rect {
  return rotation < 0
    ? { x: page.height - rect.y - rect.height, y: rect.x, width: rect.height, height: rect.width }
    : { x: rect.y, y: page.width - rect.x - rect.width, width: rect.height, height: rect.width };
}

function original(rect: Rect, page: SourcePage, rotation: number): Rect {
  return rotation < 0
    ? { x: rect.y, y: page.height - rect.x - rect.width, width: rect.height, height: rect.width }
    : { x: page.width - rect.y - rect.height, y: rect.x, width: rect.height, height: rect.width };
}

/** Sideways table captions, parallel rules and a repeated cell grid are independent evidence. */
export function rotatedTableRegions(page: SourcePage): PreservationRegion[] {
  const regions: PreservationRegion[] = [];
  const captionPattern = /^(?:table|표)\s*\d+[a-z]?\s*[:.]/iu;
  for (const rotation of [-90, 90]) {
    const items = page.items
      .filter(
        (item) =>
          !item.artifact && Math.abs((item.rotation ?? 0) - rotation) <= 1 && finiteRect(item),
      )
      .map((item) => ({ item, rect: upright(item, page, rotation) }));
    const captions = items.filter(({ item }) => captionPattern.test(item.text.trim()));
    for (const caption of captions) {
      const size = caption.item.fontSize;
      if (!Number.isFinite(size) || size <= 0) continue;
      const nextCaption = Math.min(
        ...captions
          .filter((other) => other.rect.y > caption.rect.y + size)
          .map((other) => other.rect.y),
      );
      const rules = page.graphicRegions
        .map((rect) => upright(rect, page, rotation))
        .filter(
          (rect) =>
            finiteRect(rect) &&
            rect.width >= size * 12 &&
            rect.height <= size * 1.5 &&
            rect.y >= caption.rect.y &&
            rect.y < nextCaption,
        );
      const anchor = [...rules]
        .filter(
          (rect) =>
            rect.y - caption.rect.y - caption.rect.height <= size * 4 &&
            rect.y + rect.height > caption.rect.y + caption.rect.height * 0.5,
        )
        .sort((a, b) => b.width - a.width)[0];
      if (!anchor) continue;
      const boundedRules = rules.filter(
        (rect) =>
          rect.y >= anchor.y &&
          rect.y <= anchor.y + page.width * 0.75 &&
          rect.x >= anchor.x - size &&
          rect.x + rect.width <= anchor.x + anchor.width + size,
      );
      if (boundedRules.length < 2) continue;
      const bottom = Math.max(...boundedRules.map((rect) => rect.y + rect.height));
      if (bottom - anchor.y < size * 3) continue;
      const cells = items.filter(
        ({ item, rect }) =>
          item !== caption.item &&
          rect.y >= anchor.y - size * 0.2 &&
          rect.y + rect.height <= bottom + size &&
          rect.x >= anchor.x - size &&
          rect.x + rect.width <= anchor.x + anchor.width + size &&
          item.fontSize <= size * 1.5,
      );
      const starts = (entries: typeof cells, axis: 'x' | 'y', scale: number) =>
        new Set(entries.map(({ rect }) => Math.round(rect[axis] / scale))).size;
      if (cells.length < 15 || starts(cells, 'x', size * 2) < 3 || starts(cells, 'y', size) < 3)
        continue;
      const captionParts = items.filter(
        ({ rect }) =>
          Math.abs(rect.y - caption.rect.y) <= size * 0.5 &&
          rect.x >= anchor.x - size &&
          rect.x + rect.width <= anchor.x + anchor.width + size,
      );
      const rect = original(
        union([
          caption.rect,
          ...captionParts.map((part) => part.rect),
          ...boundedRules,
          ...cells.map((cell) => cell.rect),
        ]),
        page,
        rotation,
      );
      // A rotated axis or side note must not absorb an ordinary horizontal paragraph.
      if (
        page.items.some(
          (item: SourceText) =>
            !item.artifact &&
            Math.abs(item.rotation ?? 0) < 1 &&
            item.text.trim().length > 20 &&
            intersects(item, rect),
        )
      )
        continue;
      regions.push({
        rect: clampRect(
          { x: rect.x - 2, y: rect.y - 2, width: rect.width + 4, height: rect.height + 4 },
          page.width,
          page.height,
        ),
        reason: '회전된 표의 제목·구분선·셀을 하나의 원문 영역으로 보존',
      });
    }
  }
  return regions;
}
