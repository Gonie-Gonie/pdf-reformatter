import { clampRect, finiteRect, union } from './geometry';
import type { Rect, SourcePage, SourceText } from './model';
import type { PreservationRegion } from './preservation';

interface FigureLine {
  rect: Rect;
  text: string;
  fontSize: number;
  items?: SourceText[];
}

function figureCaption(text: string): boolean {
  return /^(?:fig(?:ure)?\.?|그림)\s*(?:\d+(?:\.\d+)*|[IVX]+)[a-z]?\s*[:.)]?\s/iu.test(text.trim());
}

function sharedCaption(text: string): boolean {
  return (
    (/\(\s*left\s*\)/iu.test(text) && /\(\s*right\s*\)/iu.test(text)) ||
    /\bleft\b.+\band\s+(?:the\s+)?right\b/iu.test(text) ||
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

function originalRows(items: SourceText[]): FigureLine[] {
  const baseline = (item: SourceText) => item.baselineY ?? item.y + item.height / 2;
  const rotated = (item: SourceText) => item.preserve || Math.abs(item.rotation ?? 0) > 0.5;
  const rows: SourceText[][] = [];
  for (const item of [...items].sort((a, b) => baseline(a) - baseline(b) || a.x - b.x)) {
    const row =
      !rotated(item) &&
      rows.find(
        (entries) =>
          !rotated(entries[0]) &&
          Math.abs(baseline(entries[0]) - baseline(item)) <=
            Math.min(entries[0].fontSize, item.fontSize) * 0.35,
      );
    if (row) row.push(item);
    else rows.push([item]);
  }
  return rows.map((entries) => ({
    items: entries,
    rect: union(entries),
    fontSize: Math.max(...entries.map((item) => item.fontSize)),
    text: entries
      .sort((a, b) => a.x - b.x)
      .map((item) => item.text)
      .join(' '),
  }));
}

function runningArtwork(page: SourcePage, rect: Rect, size: number): boolean {
  if (rect.y + rect.height > page.height * 0.1 || Math.max(rect.width, rect.height) > size * 4)
    return false;
  const row = page.items.filter(
    (item) =>
      Math.abs(item.y + item.height / 2 - rect.y - rect.height / 2) <=
      Math.max(item.fontSize, rect.height * 0.5),
  );
  return (
    row.some(
      (item) =>
        /^\d{1,5}$/u.test(item.text.trim()) &&
        (item.x < page.width * 0.25 || item.x > page.width * 0.75),
    ) &&
    row.some(
      (item) =>
        (item.text.match(/\p{L}/gu)?.length ?? 0) >= 4 &&
        Math.max(item.x - rect.x - rect.width, rect.x - item.x - item.width, 0) <= size * 3,
    )
  );
}

/** Some publishers flatten a complete page into one Form, losing individual figure bounds. */
function fragmentedFigureRegions(
  page: SourcePage,
  lines: FigureLine[],
  claimed: Set<Rect>,
): PreservationRegion[] {
  const regions: PreservationRegion[] = [];
  const numberedCaption =
    /^(?:fig(?:ure)?\.?|그림)\s*(?:\d+(?:\.\d+)+[a-z]?\s*[:.)]?\s|\d+[a-z]?\s*[:.)]\s)/iu;
  for (const first of lines.filter((line) => numberedCaption.test(line.text.trim()))) {
    const size = first.fontSize;
    const caption = captionRows(first, lines);
    const captionRect = union(caption.map((line) => line.rect));
    const shortAlignedCaption = (graphic: Rect) =>
      graphic.x >= captionRect.x - size * 2 &&
      graphic.x <= captionRect.x + size * 5 &&
      first.rect.y - graphic.y - graphic.height >= 0 &&
      first.rect.y - graphic.y - graphic.height <= size * 3;
    const centeredCaption = (graphic: Rect) =>
      graphic.width >= captionRect.width &&
      graphic.width <= page.width * 0.85 &&
      Math.abs(graphic.x + graphic.width / 2 - captionRect.x - captionRect.width / 2) <= size * 2 &&
      first.rect.y - graphic.y - graphic.height >= 0 &&
      first.rect.y - graphic.y - graphic.height <= size * 14;
    const closeAnchor = page.graphicRegions.find(
      (graphic) =>
        finiteRect(graphic) &&
        (shortAlignedCaption(graphic) || centeredCaption(graphic)) &&
        Math.min(graphic.width, graphic.height) >= size * 4,
    );
    const captionSpan = closeAnchor ? union([captionRect, closeAnchor]) : captionRect;
    const eligible = page.graphicRegions.filter(
      (graphic) =>
        finiteRect(graphic) &&
        !claimed.has(graphic) &&
        !runningArtwork(page, graphic, size) &&
        graphic.width >= size * 0.3 &&
        graphic.height >= size * 0.3 &&
        graphic.y + graphic.height <= first.rect.y + size * 0.2 &&
        ((graphic.x + graphic.width / 2 >= captionSpan.x - size * 3 &&
          graphic.x + graphic.width / 2 <= captionSpan.x + captionSpan.width + size * 3) ||
          shortAlignedCaption(graphic)) &&
        graphic.width <=
          Math.max(captionRect.width * 1.35, closeAnchor ? captionSpan.width + size * 4 : 0),
    );
    const primary = eligible.filter(
      (graphic) =>
        Math.min(graphic.width, graphic.height) >= size * 4 &&
        Math.max(graphic.width, graphic.height) >= size * 10,
    );
    const anchor = [...primary]
      .filter(
        (graphic) =>
          first.rect.y - graphic.y - graphic.height <= Math.max(size * 14, page.height * 0.2),
      )
      .sort((a, b) => b.y + b.height - a.y - a.height)[0];
    if (!anchor) continue;
    const group = [anchor];
    let hull = anchor;
    let changed = true;
    while (changed) {
      changed = false;
      for (const graphic of eligible) {
        if (group.includes(graphic)) continue;
        const gapX = Math.max(
          hull.x - graphic.x - graphic.width,
          graphic.x - hull.x - hull.width,
          0,
        );
        const gapY = Math.max(
          hull.y - graphic.y - graphic.height,
          graphic.y - hull.y - hull.height,
          0,
        );
        if (gapX > size * 6 || gapY > size * 5) continue;
        group.push(graphic);
        hull = union(group);
        changed = true;
      }
    }
    const labelCandidates = page.items.length
      ? page.items.map((item) => ({ rect: item, text: item.text, fontSize: item.fontSize }))
      : lines;
    const bottomTicks = labelCandidates.filter(
      (label) =>
        /^[−–+\d.:%]+$/u.test(label.text.trim()) &&
        label.fontSize <= size * 1.2 &&
        label.rect.y >= anchor.y + anchor.height - size * 0.5 &&
        label.rect.y + label.rect.height / 2 <= anchor.y + anchor.height + size * 2.5 &&
        label.rect.x >= captionSpan.x - size &&
        label.rect.x + label.rect.width <= captionSpan.x + captionSpan.width + size,
    );
    const detachedAxis =
      bottomTicks.length >= 3 &&
      union(bottomTicks.map((label) => label.rect)).width >= anchor.width * 0.35;
    if (detachedAxis) hull = union([hull, ...bottomTicks.map((label) => label.rect)]);
    const detachedLegend =
      group.filter(
        (graphic) =>
          graphic !== anchor &&
          graphic.width <= size * 3 &&
          graphic.height <= size * 4 &&
          graphic.y >= anchor.y + anchor.height + size * 0.5 &&
          labelCandidates.some((label) => {
            const gap = label.rect.x - graphic.x - graphic.width;
            return (
              gap >= 0 &&
              gap <= size * 2 &&
              Math.abs(label.rect.y + label.rect.height / 2 - graphic.y - graphic.height / 2) <=
                graphic.height / 2 + size * 0.5 &&
              label.fontSize <= size * 1.2 &&
              label.text.trim().length > 0 &&
              label.text.length <= 40 &&
              label.text.trim().split(/\s+/u).length <= 4 &&
              !/[.!?]\s*$/u.test(label.text)
            );
          }),
      ).length >= 2;
    if (
      (group.length < 2 && !detachedAxis) ||
      hull.width >
        Math.max(captionRect.width * 1.35, closeAnchor ? captionSpan.width + size * 4 : 0) ||
      // A narrow centered chart may have a caption spanning the full text width.
      // Two labeled legend swatches provide stronger grouping evidence than width alone.
      hull.width < captionRect.width * (detachedLegend ? 0.3 : 0.45)
    )
      continue;
    const panels = primary.filter((graphic) => group.includes(graphic));
    const separateColumns = panels.some((a, index) =>
      panels.slice(index + 1).some((b) => {
        const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
        const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        return (
          overlapX < Math.min(a.width, b.width) * 0.5 &&
          overlapY > Math.min(a.height, b.height) * 0.3
        );
      }),
    );
    if (separateColumns && !sharedCaption(caption.map((line) => line.text).join(' '))) continue;
    const nearFigure = (line: FigureLine) =>
      line.rect.y >= hull.y - size * 0.75 &&
      line.rect.y + line.rect.height / 2 < first.rect.y &&
      line.rect.x + line.rect.width / 2 >= hull.x - size * 5 &&
      line.rect.x + line.rect.width / 2 <= hull.x + hull.width + size * 5;
    const sourceItems = page.items.filter((item) => {
      const center = item.x + item.width / 2;
      return (
        center >= captionRect.x - size * 0.5 &&
        center <= captionRect.x + captionRect.width + size * 0.5 &&
        nearFigure({ rect: item, text: item.text, fontSize: item.fontSize })
      );
    });
    const proofLines = page.items.length ? originalRows(sourceItems) : lines;
    const nearby = proofLines.filter(
      (line) =>
        !caption.includes(line) &&
        !line.items?.some((item) => item.preserve || Math.abs(item.rotation ?? 0) > 0.5) &&
        nearFigure(line),
    );
    const compactAxisRow = (line: FigureLine) =>
      line.fontSize <= size * 0.85 &&
      !/[.!?]\s*$/u.test(line.text) &&
      (line.text.length <= 140 || /^[−–+\d\s.:%]+$/u.test(line.text)) &&
      panels.some(
        (panel) =>
          line.rect.y >= panel.y + panel.height - size * 0.5 &&
          line.rect.y + line.rect.height / 2 <= panel.y + panel.height + size * 2,
      );
    if (
      nearby.some(
        (line) =>
          figureCaption(line.text) ||
          /^(?:table|표)\s*\d/iu.test(line.text.trim()) ||
          (!panels.some((panel) => insidePanel(line, panel)) &&
            line.rect.x < hull.x + hull.width &&
            line.rect.x + line.rect.width > hull.x &&
            ((!compactAxisRow(line) && line.text.length > 80) ||
              (line.text.trim().split(/\s+/u).length >= 10 &&
                (line.text.match(/\p{L}{4,}/gu)?.length ?? 0) >= 5 &&
                !compactAxisRow(line)) ||
              (/[.!?]\s*$/u.test(line.text) && line.text.trim().split(/\s+/u).length >= 4))),
      )
    )
      continue;
    // A rotated axis can have been joined to an unrelated body row by gutter inference.
    // Expand from original text items, before that inference, without chaining outward.
    const annotations: FigureLine[] = page.items.length
      ? sourceItems.map((item) => ({ rect: item, text: item.text, fontSize: item.fontSize }))
      : nearby;
    const labels = annotations.filter(
      (line) =>
        nearFigure(line) &&
        line.fontSize <= size * 1.6 &&
        line.text.length <= 80 &&
        line.text.trim().split(/\s+/u).length < 10 &&
        !/[.!?]\s*$/u.test(line.text),
    );
    const rect = union([hull, ...labels.map((line) => line.rect)]);
    const bottom = Math.min(rect.y + rect.height + 2, first.rect.y - 0.5);
    regions.push({
      rect: clampRect(
        { x: rect.x - 2, y: rect.y - 2, width: rect.width + 4, height: bottom - rect.y + 2 },
        page.width,
        page.height,
      ),
      reason: '그림의 분리된 본체·축·범례를 함께 보존',
    });
    group.forEach((graphic) => claimed.add(graphic));
  }
  return regions;
}

function sideCaptionRegions(
  page: SourcePage,
  lines: FigureLine[],
  claimed: Set<Rect>,
): PreservationRegion[] {
  const regions: PreservationRegion[] = [];
  for (const caption of lines.filter((line) => figureCaption(line.text))) {
    const size = caption.fontSize;
    if (caption.rect.x < page.width * 0.5 || caption.rect.width > page.width * 0.4) continue;
    for (const graphic of page.graphicRegions) {
      if (
        claimed.has(graphic) ||
        graphic.width < size * 10 ||
        graphic.height < size * 6 ||
        caption.rect.x < graphic.x + graphic.width ||
        caption.rect.x - graphic.x - graphic.width > size * 15 ||
        Math.abs(caption.rect.y - graphic.y) > size * 2
      )
        continue;
      const labels = page.items.filter(
        (item) =>
          !item.artifact &&
          !item.preserve &&
          item.text.trim().length > 0 &&
          item.text.length <= 64 &&
          item.text.trim().split(/\s+/u).length <= 5 &&
          !/[.!?]\s*$/u.test(item.text) &&
          !figureCaption(item.text) &&
          item.fontSize <= size * 1.5 &&
          item.width <= item.fontSize * 16 &&
          item.height <= item.fontSize * 2.5 &&
          item.x < graphic.x + graphic.width + size * 3 &&
          item.x + item.width > graphic.x - size * 3 &&
          item.y < graphic.y + graphic.height + size * 2 &&
          item.y + item.height > graphic.y - size,
      );
      const repeatedFonts = new Set(
        labels
          .filter((item) => labels.filter((other) => other.fontName === item.fontName).length >= 3)
          .map((item) => item.fontName),
      );
      const provenLabels = labels.filter((item) => repeatedFonts.has(item.fontName));
      if (provenLabels.length < 3) continue;
      const rect = union([graphic, ...provenLabels]);
      regions.push({
        rect: clampRect(
          { x: rect.x - 2, y: rect.y - 2, width: rect.width + 4, height: rect.height + 4 },
          page.width,
          page.height,
        ),
        reason: '옆에 제목이 있는 그림의 동일 서체 주석을 함께 보존',
      });
      claimed.add(graphic);
    }
  }
  return regions;
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
  return [
    ...regions,
    ...fragmentedFigureRegions(page, lines, claimed),
    ...sideCaptionRegions(page, lines, claimed),
  ];
}
