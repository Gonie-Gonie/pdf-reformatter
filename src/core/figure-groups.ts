import { clampRect, finiteRect, union } from './geometry';
import type { Rect, SourcePage } from './model';
import type { PreservationRegion } from './preservation';

interface FigureLine {
  rect: Rect;
  text: string;
  fontSize: number;
}

function figureCaption(text: string): boolean {
  return /^(?:fig(?:ure)?\.?|그림)\s*[\dIVX]+\s*[:.)]?\s/iu.test(text.trim());
}

function sharedCaption(text: string): boolean {
  return (
    (/\(\s*left\s*\)/iu.test(text) && /\(\s*right\s*\)/iu.test(text)) ||
    (/\(\s*a\s*\)/iu.test(text) && /\(\s*b\s*\)/iu.test(text))
  );
}

function captionRows(start: FigureLine, lines: FigureLine[]): FigureLine[] {
  const caption = [start];
  for (const line of lines) {
    if (line === start || line.rect.y <= start.rect.y + start.fontSize * 0.5) continue;
    const previous = caption[caption.length - 1];
    const gap = line.rect.y - previous.rect.y - previous.rect.height;
    if (gap > start.fontSize * 0.85) break;
    if (
      gap < -start.fontSize * 0.3 ||
      Math.abs(line.fontSize - start.fontSize) > start.fontSize * 0.2 ||
      Math.abs(line.rect.x - start.rect.x) > start.fontSize * 1.5 ||
      line.rect.x + line.rect.width > start.rect.x + start.rect.width + start.fontSize * 2 ||
      figureCaption(line.text) ||
      caption.length >= 8
    ) {
      break;
    }
    caption.push(line);
  }
  return caption;
}

function insidePanel(line: FigureLine, panel: Rect): boolean {
  const overlapX =
    Math.min(line.rect.x + line.rect.width, panel.x + panel.width) - Math.max(line.rect.x, panel.x);
  const overlapY =
    Math.min(line.rect.y + line.rect.height, panel.y + panel.height) -
    Math.max(line.rect.y, panel.y);
  return overlapX >= line.rect.width * 0.6 && overlapY >= line.rect.height * 0.45;
}

/** Explicit panel references bind two illustrations, their compact titles and caption. */
export function sharedFigureRegions(
  page: SourcePage,
  inputLines: FigureLine[],
): PreservationRegion[] {
  const regions: PreservationRegion[] = [];
  const claimed = new Set<Rect>();
  const lines = inputLines
    .filter((line) => finiteRect(line.rect) && Number.isFinite(line.fontSize) && line.fontSize > 0)
    .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  for (const first of lines.filter((line) => figureCaption(line.text))) {
    const caption = captionRows(first, lines);
    if (!sharedCaption(caption.map((line) => line.text).join(' '))) continue;
    const size = first.fontSize;
    const captionRect = union(caption.map((line) => line.rect));
    const graphics = page.graphicRegions.filter(
      (graphic) =>
        finiteRect(graphic) &&
        !claimed.has(graphic) &&
        graphic.width >= size * 1.5 &&
        graphic.height >= size * 3 &&
        graphic.y + graphic.height <= first.rect.y + size * 0.2 &&
        first.rect.y - graphic.y - graphic.height <= size * 8 &&
        graphic.x + graphic.width / 2 >= captionRect.x &&
        graphic.x + graphic.width / 2 <= captionRect.x + captionRect.width,
    );
    for (let index = 0; index < graphics.length; index++) {
      let grouped = false;
      for (const other of graphics.slice(index + 1)) {
        const pair = [graphics[index], other].sort((a, b) => a.x - b.x);
        const [left, right] = pair;
        const gap = right.x - left.x - left.width;
        const overlapY =
          Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y);
        const panels = union(pair);
        if (
          gap < size ||
          gap > page.width * 0.25 ||
          overlapY < Math.min(left.height, right.height) * 0.6 ||
          Math.abs(left.y - right.y) > Math.max(left.height, right.height) * 0.35 ||
          Math.max(left.height, right.height) > Math.min(left.height, right.height) * 3 ||
          first.rect.y - panels.y - panels.height > size * 6 ||
          captionRect.width < panels.width * 0.85
        ) {
          continue;
        }
        const between = lines.filter(
          (line) =>
            !caption.includes(line) &&
            line.rect.y + line.rect.height / 2 >= panels.y &&
            line.rect.y + line.rect.height / 2 < first.rect.y &&
            line.rect.x < captionRect.x + captionRect.width &&
            line.rect.x + line.rect.width > captionRect.x,
        );
        if (
          between.some(
            (line) =>
              figureCaption(line.text) ||
              (!pair.some((panel) => insidePanel(line, panel)) &&
                (line.text.length > 70 || line.text.trim().split(/\s+/u).length >= 12)),
          )
        ) {
          continue;
        }
        const titles = lines.filter((line) => {
          const bottom = line.rect.y + line.rect.height;
          const center = line.rect.x + line.rect.width / 2;
          const centered = pair.some(
            (panel) => Math.abs(center - panel.x - panel.width / 2) <= size * 1.5,
          );
          const spansBoth =
            line.rect.x < left.x + left.width / 2 &&
            line.rect.x + line.rect.width > right.x + right.width / 2;
          return (
            bottom <= panels.y + size * 0.3 &&
            panels.y - bottom <= size * 2 &&
            line.rect.x >= panels.x - size * 3 &&
            line.rect.x + line.rect.width <= panels.x + panels.width + size * 3 &&
            line.fontSize <= size * 1.6 &&
            line.text.length <= 100 &&
            !/[.!?]\s*$/u.test(line.text) &&
            !figureCaption(line.text) &&
            (centered || spansBoth)
          );
        });
        const rect = union([
          panels,
          captionRect,
          ...between.map((line) => line.rect),
          ...titles.map((line) => line.rect),
        ]);
        regions.push({
          rect: clampRect(
            { x: rect.x - 2, y: rect.y - 2, width: rect.width + 4, height: rect.height + 4 },
            page.width,
            page.height,
          ),
          reason: '공통 설명이 있는 나란한 그림과 제목을 함께 보존',
        });
        for (const graphic of pair) claimed.add(graphic);
        grouped = true;
        break;
      }
      if (grouped) break;
    }
  }
  return regions;
}
