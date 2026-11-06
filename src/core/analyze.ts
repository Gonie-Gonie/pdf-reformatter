import type {
  BlockKind,
  Overrides,
  ReadingBlock,
  ReadingDocument,
  Rect,
  SourceDocument,
  SourcePage,
  SourceSpan,
  SourceText,
} from './model';
import { clampRect, finiteRect, intersects, union } from './geometry';
import { findColumnGutter } from './columns';
import { closePreservationRegions, ownsPreservedText, preservedRasterRect } from './preservation';
import type { PreservationRegion } from './preservation';
import {
  analyzePageSemantics,
  noteMarkerIds,
  resolveNoteReferences,
  sourceSpans,
} from './semantics';
import type { PageSemantics } from './semantics';
import { detectRunningContent } from './running-content';
import type { RunningContent } from './running-content';

interface Line {
  items: SourceText[];
  rect: Rect;
  text: string;
  fontSize: number;
}
interface Unit {
  rect: Rect;
  line?: Line;
  block?: ReadingBlock;
  zone?: string;
  gutter?: number;
}
const mathCharacters =
  /[∑∏∫√∞≠≤≥≈∂∇⊂⊃∈∉∀∃±×÷⇌↔⇒⇔²³¹\u2070-\u209fαβγδεζηθικλμνξοπρστυφχψωΓΔΘΛΞΠΣΥΦΨΩ]/u;
const unspacedScripts = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

function median(values: number[]): number {
  const sorted = values
    .filter((value) => value > 0 && Number.isFinite(value))
    .sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 12;
}

function itemText(items: SourceText[]): string {
  let result = '';
  let previous: SourceText | undefined;
  for (const item of items) {
    const gap = previous ? item.x - previous.x - previous.width : 0;
    if (
      previous &&
      gap > Math.min(item.fontSize, previous.fontSize) * 0.15 &&
      !/\s$/u.test(result) &&
      !/^\s/u.test(item.text)
    )
      result += ' ';
    result += item.text;
    previous = item;
  }
  return result;
}

function buildLines(
  items: SourceText[],
  gutter?: number,
  referenceIds = new Set<string>(),
): Line[] {
  const rows: { anchor: SourceText; items: SourceText[] }[] = [];
  // A row's anchor stays fixed. Superscripts must not enlarge its box until it
  // touches the next baseline and joins an entire paragraph into a single row.
  for (const item of [...items].sort((a, b) => b.fontSize - a.fontSize || a.y - b.y || a.x - b.x)) {
    let nearest: (typeof rows)[number] | undefined;
    let distance = Infinity;
    for (const candidate of rows) {
      const anchor = candidate.anchor;
      const centerDistance = Math.abs(anchor.y + anchor.height / 2 - item.y - item.height / 2);
      const hasBaseline = anchor.baselineY !== undefined && item.baselineY !== undefined;
      const baselineDistance = hasBaseline
        ? Math.abs(anchor.baselineY! - item.baselineY!)
        : centerDistance;
      const overlap =
        Math.min(anchor.y + anchor.height, item.y + item.height) - Math.max(anchor.y, item.y);
      const aligned = hasBaseline
        ? baselineDistance <= Math.max(anchor.fontSize, item.fontSize) * 0.3
        : overlap > Math.min(anchor.height, item.height) * 0.3 ||
          centerDistance < Math.max(item.fontSize, anchor.fontSize) * 0.45;
      const marker = candidate.items.some((entry) => {
        const marker = referenceIds.has(entry.id)
          ? entry
          : referenceIds.has(item.id)
            ? item
            : undefined;
        const body = marker === entry ? item : entry;
        return (
          marker &&
          baselineDistance < anchor.fontSize * 0.8 &&
          !(gutter !== undefined && body.x < gutter && marker.x >= gutter) &&
          marker.x >= body.x + body.width - body.fontSize * 0.5 &&
          marker.x <= body.x + body.width + body.fontSize * 1.5
        );
      });
      const adornment =
        (item.fontSize < anchor.fontSize * 0.85 ||
          (item.width === 0 && /^\p{Mark}+$/u.test(item.text))) &&
        baselineDistance <= anchor.fontSize * 0.8 &&
        candidate.items.some(
          (entry) =>
            !(gutter !== undefined && entry.x < gutter && item.x >= gutter) &&
            item.x >= entry.x - anchor.fontSize &&
            item.x <= entry.x + entry.width + anchor.fontSize,
        );
      if ((aligned || marker || adornment) && baselineDistance < distance) {
        nearest = candidate;
        distance = baselineDistance;
      }
    }
    if (nearest) nearest.items.push(item);
    else rows.push({ anchor: item, items: [item] });
  }
  const lines: Line[] = [];
  for (const row of rows) {
    const sorted = row.items.sort((a, b) => a.x - b.x);
    let segment: SourceText[] = [];
    for (const item of sorted) {
      const previous = segment.at(-1);
      if (
        previous &&
        ((gutter !== undefined && previous.x < gutter && item.x >= gutter) ||
          (!referenceIds.has(item.id) &&
            !referenceIds.has(previous.id) &&
            item.x - previous.x - previous.width >
              Math.max(36, Math.min(previous.fontSize, item.fontSize) * 3)))
      ) {
        lines.push(makeLine(segment));
        segment = [];
      }
      segment.push(item);
    }
    if (segment.length) lines.push(makeLine(segment));
  }
  return lines.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
}

function makeLine(items: SourceText[]): Line {
  return {
    items,
    rect: union(items),
    text: itemText(items),
    fontSize: median(items.map((item) => item.fontSize)),
  };
}

function mathLine(line: Line, referenceIds = new Set<string>()): boolean {
  const items = line.items.filter((item) => !referenceIds.has(item.id));
  const sizes = items.map((item) => item.fontSize).filter((size) => size > 0);
  const size = median(sizes);
  const baseline = median(
    items
      .filter((item) => item.fontSize >= size * 0.9 && item.baselineY !== undefined)
      .map((item) => item.baselineY!),
  );
  return (
    mathCharacters.test(itemText(items)) ||
    items.some(
      (item) =>
        /[\u0000\ufffd]/u.test(item.text) || (item.width === 0 && /^\p{Mark}+$/u.test(item.text)),
    ) ||
    items.some((item) => /math|symbol|cmsy|cmmi|cmex|msam|msbm/i.test(item.fontName)) ||
    items.some(
      (item) =>
        item.baselineY !== undefined &&
        item.fontSize < size * 0.85 &&
        Math.abs(item.baselineY - baseline) > size * 0.2,
    ) ||
    (sizes.length > 1 && Math.max(...sizes) / Math.min(...sizes) > 1.4)
  );
}

function captionLine(line: Line): boolean {
  return /^(?:fig(?:ure)?\.?|table|eq(?:uation)?\.?|그림|표|수식)\s*[\dIVX]/iu.test(
    line.text.trim(),
  );
}

function equationNumber(line: Line): boolean {
  return /^[（(]\s*\d+[a-z]?\s*[)）]$/iu.test(line.text.trim());
}

function standaloneMath(line: Line, referenceIds = new Set<string>()): boolean {
  if (captionLine(line) || equationNumber(line) || line.text.length > 150) return false;
  const longWords = line.text.match(/[a-z]{4,}/giu) ?? [];
  return (
    longWords.length <= 1 &&
    (mathLine(line, referenceIds) || /(?:[a-z\d]\s*[=+−-]\s*[a-z\d])/iu.test(line.text))
  );
}

function nearbyEquation(a: Rect, b: Rect, bodySize: number): boolean {
  const verticalGap = Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height);
  const horizontalGap = Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width);
  return verticalGap <= bodySize * 1.8 && horizontalGap <= bodySize * 4;
}

function sourceBlock(
  page: SourcePage,
  rect: Rect,
  items: SourceText[],
  reason: string,
): ReadingBlock {
  const lines = buildLines(items);
  const ordered = lines.flatMap((line) => line.items);
  return {
    id: `p${page.number}:region:${items[0]?.id ?? `${rect.x.toFixed(2)}:${rect.y.toFixed(2)}`}`,
    kind: 'sourceRegion',
    sourcePage: page.number,
    sourceIds: ordered.map((item) => item.id),
    sourceSpans: sourceSpans(ordered),
    rect,
    rawText: items.map((item) => item.text).join(''),
    text: joinLines(lines),
    fontSize: median(items.map((item) => item.fontSize)),
    reason,
    confidence: 'review',
  };
}

function pageFallback(page: SourcePage, reason: string): ReadingBlock[] {
  return [
    sourceBlock(page, { x: 0, y: 0, width: page.width, height: page.height }, page.items, reason),
  ];
}

/** Expand preservation to whole text items, and merge overlaps until ownership is unambiguous. */
function preservationRegions(
  page: SourcePage,
  lines: Line[],
  referenceIds = new Set<string>(),
): PreservationRegion[] {
  const bands = columnBands(page, page.items);
  const sameColumn = (a: Rect, b: Rect): boolean => {
    const band = bands.find((entry) => a.y >= entry.top && a.y < entry.bottom);
    if (!band || b.y < band.top || b.y >= band.bottom) return false;
    const gutter = band.gutter;
    return (
      gutter === undefined ||
      !((a.x + a.width <= gutter && b.x >= gutter) || (b.x + b.width <= gutter && a.x >= gutter))
    );
  };
  const pad = (rect: Rect): Rect =>
    clampRect(
      { x: rect.x - 2, y: rect.y - 2, width: rect.width + 4, height: rect.height + 4 },
      page.width,
      page.height,
    );
  const bodySize = median(
    page.items.filter((item) => item.text.trim().length > 8).map((item) => item.fontSize),
  );
  const regions: { rect: Rect; reason: string; displayMath?: boolean }[] = page.graphicRegions
    .filter(finiteRect)
    .map((rect) => ({ rect: pad(rect), reason: '그림·표·벡터 도형을 원문 모양으로 보존' }));
  for (const item of page.items.filter((item) => item.preserve))
    regions.push({ rect: pad(item), reason: '회전된 글자와 해당 원문 영역만 보존' });
  for (const line of lines) {
    if ((mathLine(line, referenceIds) || standaloneMath(line, referenceIds)) && !captionLine(line))
      regions.push({
        rect: pad(line.rect),
        reason: '수식 또는 첨자가 포함된 줄을 원문 모양으로 보존',
        displayMath: standaloneMath(line, referenceIds),
      });
  }
  // Gutter detection and large extraction gaps can split one display equation
  // into several text runs. Join mathematical neighbors, fraction rules and
  // their number before assigning any of those runs to flowing prose.
  let mathChanged = true;
  let mathPasses = 0;
  while (mathChanged && mathPasses++ < lines.length + regions.length + 2) {
    mathChanged = false;
    for (const region of regions) {
      if (!region.displayMath) continue;
      const neighbors = lines.filter(
        (line) =>
          standaloneMath(line, referenceIds) &&
          sameColumn(region.rect, line.rect) &&
          nearbyEquation(region.rect, line.rect, bodySize),
      );
      const numbers = lines.filter(
        (line) =>
          equationNumber(line) &&
          sameColumn(region.rect, line.rect) &&
          !line.items.some((item) => referenceIds.has(item.id)) &&
          line.rect.y < region.rect.y + region.rect.height + bodySize * 0.4 &&
          line.rect.y + line.rect.height > region.rect.y - bodySize * 0.4,
      );
      const drawings = regions.filter(
        (other) =>
          other !== region &&
          sameColumn(region.rect, other.rect) &&
          (other.displayMath || other.reason === '그림·표·벡터 도형을 원문 모양으로 보존') &&
          nearbyEquation(region.rect, other.rect, bodySize),
      );
      const expanded = clampRect(
        union([
          region.rect,
          ...neighbors.map((line) => pad(line.rect)),
          ...numbers.map((line) => pad(line.rect)),
          ...drawings.map((other) => other.rect),
        ]),
        page.width,
        page.height,
      );
      if (JSON.stringify(expanded) !== JSON.stringify(region.rect)) {
        region.rect = expanded;
        region.reason = '분리 추출된 수식·분수·번호를 하나의 원문 영역으로 보존';
        mathChanged = true;
      }
    }
  }
  return closePreservationRegions(page, regions);
}

function classify(line: Line, page: SourcePage, bodySize: number): BlockKind {
  const value = line.text.trim();
  if (captionLine(line)) return 'caption';
  if (/^(?:\[\d+\]|\d+\.)\s*\S/u.test(value) && /(?:\b(?:19|20)\d{2}\b|doi|https?:)/iu.test(value))
    return 'reference';
  if (line.rect.y > page.height * 0.79 && line.fontSize < bodySize * 0.88) return 'footnote';
  if (
    (value.length < 120 &&
      /^\d{1,2}(?:\.\d{1,2}){1,5}\.?\s+\p{L}/u.test(value) &&
      !/[.!?。！？]$/u.test(value)) ||
    line.fontSize > bodySize * 1.18 ||
    (value.length < 100 &&
      line.items.some((item) => /bold|black|heavy/i.test(item.fontName)) &&
      line.fontSize >= bodySize)
  )
    return 'heading';
  if (/^(?:[•●▪◦‣*-]|\d+[.)]|[a-z][.)])\s+\S/iu.test(value)) return 'list';
  return 'paragraph';
}

/** Only explicit, isolated page-wide rules justify a change of column layout. */
function columnBands(page: SourcePage, items: SourceText[]) {
  const bodySize = median(page.items.map((item) => item.fontSize));
  const separators = page.graphicRegions
    .filter(
      (region) =>
        region.width >= page.width * 0.8 &&
        region.height <= Math.min(10, bodySize * 0.9) &&
        !page.items.some((item) => {
          const center = item.y + item.height / 2;
          return (
            center >= region.y - 1 &&
            center <= region.y + region.height + 1 &&
            item.x < region.x + region.width &&
            item.x + item.width > region.x
          );
        }),
    )
    .map((region) => region.y + region.height / 2)
    .sort((a, b) => a - b);
  const cuts = [-Infinity, ...separators, Infinity];
  return cuts.slice(0, -1).map((top, index) => {
    const bottom = cuts[index + 1];
    const selected = items.filter((item) => item.y >= top && item.y < bottom);
    return {
      top,
      bottom,
      items: selected,
      gutter: findColumnGutter(selected, page.width, page.graphicRegions),
    };
  });
}

function orderUnits(units: Unit[], gutter: number | undefined): Unit[] {
  if (!gutter)
    return units
      .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)
      .map((unit) => ({ ...unit, zone: 'single' }));
  const barriers = units
    .filter((unit) => unit.rect.x < gutter && unit.rect.x + unit.rect.width > gutter)
    .sort((a, b) => a.rect.y - b.rect.y);
  const other = units.filter((unit) => !barriers.includes(unit));
  const result: Unit[] = [];
  let lower = -Infinity;
  let band = 0;
  for (const barrier of [...barriers, undefined]) {
    const upper = barrier ? barrier.rect.y : Infinity;
    const inBand = other.filter((unit) => unit.rect.y >= lower && unit.rect.y < upper);
    for (const side of ['left', 'right'] as const) {
      result.push(
        ...inBand
          .filter((unit) => unit.rect.x < gutter === (side === 'left'))
          .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)
          .map((unit) => ({ ...unit, zone: `${band}:${side}` })),
      );
    }
    if (barrier) result.push({ ...barrier, zone: `${band}:barrier` });
    lower = upper;
    band++;
  }
  return result;
}

function canJoin(previous: Line, next: Line, kind: BlockKind, zoneWidth: number): boolean {
  if (kind === 'heading' || kind === 'caption') return false;
  const gap = next.rect.y - previous.rect.y - previous.rect.height;
  if (
    next.rect.y <= previous.rect.y ||
    gap < -Math.min(previous.rect.height, next.rect.height) * 0.4 ||
    gap > Math.max(previous.fontSize, next.fontSize) * 0.95
  )
    return false;
  if (Math.abs(previous.fontSize - next.fontSize) > previous.fontSize * 0.15) return false;
  if (Math.abs(previous.rect.x - next.rect.x) > previous.fontSize * 1.6) return false;
  if (previous.rect.width < zoneWidth * 0.65 && /[.!?。！？:]\s*$/u.test(previous.text))
    return false;
  if (/^(?:[•●▪◦‣*-]|\d+[.)])\s/u.test(next.text.trim())) return false;
  return true;
}

function joinLines(lines: Line[]): string {
  return lines.reduce((value, line) => {
    const text = line.text.trim();
    if (!value) return text;
    const noSpace = unspacedScripts.test(value.slice(-1)) && unspacedScripts.test(text.slice(0, 1));
    return value + (noSpace ? '' : ' ') + text;
  }, '');
}

function analyzePage(
  page: SourcePage,
  semantic: PageSemantics,
): { blocks: ReadingBlock[]; warnings: string[] } {
  if (
    !Number.isFinite(page.width) ||
    !Number.isFinite(page.height) ||
    page.width <= 0 ||
    page.height <= 0
  )
    throw new Error(`${page.number}쪽의 페이지 크기가 잘못되었습니다.`);
  if (page.rotation % 360 !== 0)
    return {
      blocks: pageFallback(page, '회전된 페이지는 읽기 순서 오판을 피하기 위해 전체 원문 보존'),
      warnings: [`${page.number}쪽: 회전 페이지를 전체 보존했습니다.`],
    };
  if (page.warnings.some((warning) => /회전 문자|세로쓰기|오른쪽에서 왼쪽/u.test(warning)))
    return {
      blocks: pageFallback(
        page,
        '회전 문자·세로쓰기·오른쪽에서 왼쪽 쓰기를 포함하여 페이지 전체 보존',
      ),
      warnings: [`${page.number}쪽: 지원하지 않는 쓰기 방향을 원문으로 보존했습니다.`],
    };
  if (!page.items.some((item) => item.text.trim()))
    return {
      blocks: pageFallback(page, '추출 가능한 텍스트가 없는 페이지. OCR 없이 원문 전체 보존'),
      warnings: [`${page.number}쪽: 추출 가능한 텍스트가 없어 전체 보존했습니다.`],
    };
  if (
    page.items.some(
      (item) =>
        ![item.x, item.y, item.width, item.height, item.fontSize].every(Number.isFinite) ||
        item.width < 0 ||
        item.height <= 0,
    )
  )
    return {
      blocks: pageFallback(page, '문자 좌표가 불확실하여 페이지 전체 보존'),
      warnings: [`${page.number}쪽: 문자 좌표를 확인해야 합니다.`],
    };
  // Infer the gutter before joining runs on the same baseline. A narrow gutter
  // otherwise disappears when left and right column runs become one long line.
  if (
    page.items.some(
      (item) =>
        item.x < -0.5 ||
        item.y < -0.5 ||
        item.x + item.width > page.width + 0.5 ||
        item.y + item.height > page.height + 0.5,
    )
  )
    return {
      blocks: pageFallback(page, '보이는 페이지 밖으로 잘린 문자를 포함하여 원문 페이지 전체 보존'),
      warnings: [`${page.number}쪽: 페이지 경계에서 잘린 문자를 원문 모양으로 보존했습니다.`],
    };
  const specialIds = new Set(semantic.blocks.flatMap((block) => block.sourceIds));
  const numberIds = new Set(semantic.lineNumbers.map((entry) => entry.item.id));
  const workingPage: SourcePage = {
    ...page,
    items: page.items.filter((item) => !specialIds.has(item.id) && !numberIds.has(item.id)),
    graphicRegions: page.graphicRegions.filter(
      (region) =>
        !semantic.blocks.some((block) => {
          if (block.kind !== 'sourceRegion') return false;
          if (
            region.x >= block.rect.x &&
            region.y >= block.rect.y &&
            region.x + region.width <= block.rect.x + block.rect.width &&
            region.y + region.height <= block.rect.y + block.rect.height
          )
            return true;
          if (block.semantic !== 'table') return false;
          const overlapWidth = Math.max(
            0,
            Math.min(region.x + region.width, block.rect.x + block.rect.width) -
              Math.max(region.x, block.rect.x),
          );
          const overlapHeight = Math.max(
            0,
            Math.min(region.y + region.height, block.rect.y + block.rect.height) -
              Math.max(region.y, block.rect.y),
          );
          return overlapWidth * overlapHeight >= region.width * region.height * 0.75;
        }),
    ),
  };
  const initialBands = columnBands(workingPage, workingPage.items);
  const lines = initialBands.flatMap((band) =>
    buildLines(band.items, band.gutter, semantic.referenceIds),
  );
  const regions = preservationRegions(workingPage, lines, semantic.referenceIds);
  const claimed = new Set<string>();
  const units: Unit[] = [
    ...semantic.blocks.map((block) => ({ rect: block.rect, block })),
    ...regions.map((region) => {
      const items = workingPage.items.filter(
        (item) => ownsPreservedText(region.rect, item) && !claimed.has(item.id),
      );
      items.forEach((item) => claimed.add(item.id));
      const rect = preservedRasterRect(workingPage, region, items);
      return { rect, block: sourceBlock(page, rect, items, region.reason) };
    }),
  ];
  const remainingItems = workingPage.items.filter((item) => !claimed.has(item.id));
  // Labels inside a chart/table must not suggest columns for surrounding prose.
  const bands = columnBands(workingPage, remainingItems).map((band, index) => ({
    ...band,
    gutter: band.gutter ?? initialBands[index].gutter,
  }));
  const remainingLines = bands.flatMap((band) =>
    buildLines(band.items, band.gutter, semantic.referenceIds),
  );
  units.push(...remainingLines.map((line) => ({ rect: line.rect, line })));
  const ordered = bands.flatMap((band, index) =>
    orderUnits(
      units.filter((unit) => unit.rect.y >= band.top && unit.rect.y < band.bottom),
      band.gutter,
    ).map((unit) => ({ ...unit, gutter: band.gutter, zone: `${index}:${unit.zone}` })),
  );
  const hasColumns = ordered.some((unit) => unit.gutter !== undefined);
  const bodySize = median(
    workingPage.items.filter((item) => item.text.trim().length > 8).map((item) => item.fontSize),
  );
  const blocks: ReadingBlock[] = [];
  let paragraph: Line[] = [];
  let previousZone: string | undefined;
  let kind: BlockKind = 'paragraph';
  function flush() {
    if (!paragraph.length) return;
    const items = paragraph.flatMap((line) => line.items);
    blocks.push({
      id: `p${page.number}:${items[0].id}`,
      kind,
      sourcePage: page.number,
      sourceIds: items.map((item) => item.id),
      sourceSpans: sourceSpans(items),
      rect: union(paragraph.map((line) => line.rect)),
      rawText: paragraph.map((line) => line.items.map((item) => item.text).join('')).join('\n'),
      text: joinLines(paragraph),
      fontSize: median(paragraph.map((line) => line.fontSize)),
      confidence: hasColumns ? 'review' : 'high',
    });
    paragraph = [];
  }
  for (const unit of ordered) {
    if (unit.block) {
      flush();
      blocks.push(unit.block);
      previousZone = unit.zone;
      continue;
    }
    const line = unit.line!;
    const nextKind = classify(line, page, bodySize);
    const zoneWidth = unit.gutter
      ? unit.zone?.endsWith('left')
        ? unit.gutter
        : page.width - unit.gutter
      : page.width - Math.min(...remainingLines.map((entry) => entry.rect.x)) * 2;
    if (
      paragraph.length &&
      (previousZone !== unit.zone ||
        nextKind !== kind ||
        !canJoin(paragraph.at(-1)!, line, kind, zoneWidth))
    )
      flush();
    kind = nextKind;
    previousZone = unit.zone;
    paragraph.push(line);
  }
  flush();
  const owners = new Map(
    blocks.flatMap((block) => block.sourceIds.map((id) => [id, block] as const)),
  );
  const originals = new Map(page.items.map((item) => [item.id, item]));
  for (const entry of semantic.lineNumbers) {
    const target = entry.targetId
      ? owners.get(entry.targetId)
      : blocks.find(
          (block) =>
            block.kind === 'sourceRegion' &&
            entry.targetRect &&
            intersects(block.rect, entry.targetRect),
        );
    if (!target) {
      blocks.push(sourceBlock(page, entry.item, [entry.item], '줄번호의 원문 위치 보존'));
      continue;
    }
    if (target.kind === 'sourceRegion' && intersects(target.rect, entry.item)) {
      target.sourceIds.push(entry.item.id);
      target.rect = clampRect(union([target.rect, entry.item]), page.width, page.height);
      continue;
    }
    const seed = entry.targetId ? originals.get(entry.targetId) : undefined;
    const start = seed
      ? target.sourceSpans
          ?.filter((span) => {
            const overlap =
              Math.min(span.rect.y + span.rect.height, seed.y + seed.height) -
              Math.max(span.rect.y, seed.y);
            return (
              overlap > Math.min(span.rect.height, seed.height) * 0.3 ||
              Math.abs(span.rect.y + span.rect.height / 2 - seed.y - seed.height / 2) <
                Math.max(span.rect.height, seed.height) * 0.45
            );
          })
          .reduce<SourceSpan | undefined>(
            (first, span) => (!first || span.rect.x < first.rect.x ? span : first),
            undefined,
          )
      : undefined;
    blocks.push({
      id: `p${page.number}:line-number:${entry.item.id}`,
      kind: 'lineNumber',
      sourcePage: page.number,
      sourceIds: [entry.item.id],
      sourceSpans: sourceSpans([entry.item]),
      rect: entry.item,
      rawText: entry.item.text,
      text: entry.item.text,
      fontSize: entry.item.fontSize,
      confidence: 'high',
      anchor: {
        blockId: target.id,
        ...(entry.targetId ? { sourceId: start?.sourceId ?? entry.targetId } : {}),
      },
    });
  }
  const assigned = blocks.flatMap((block) => block.sourceIds);
  if (assigned.length !== page.items.length || new Set(assigned).size !== assigned.length) {
    return {
      blocks: pageFallback(page, '원문 요소 소유권 검증 실패로 페이지 전체 보존'),
      warnings: [`${page.number}쪽: 분석 소유권을 확인하지 못해 전체 보존했습니다.`],
    };
  }
  return {
    blocks,
    warnings: [
      ...(hasColumns
        ? [`${page.number}쪽: 2단 구성을 감지했습니다. 왼쪽 단 다음 오른쪽 단의 순서를 확인하세요.`]
        : []),
      ...(regions.some(
        (region) => region.reason.includes('수식') && region.rect.height > bodySize * 2,
      )
        ? [
            `${page.number}쪽: 수식과 인접 영역을 함께 보존했습니다. 수식·번호의 범위를 원문과 대조하세요.`,
          ]
        : []),
    ],
  };
}

/** Geometry heuristics are deliberately conservative and do not claim semantic understanding. */
function runningBlocks(page: SourcePage, content?: RunningContent): ReadingBlock[] {
  if (!content) return [];
  const numbered = new Set(content.pageNumberIds);
  const selections = [
    { ids: content.headerIds, position: 'header' as const, folio: false },
    { ids: content.footerIds, position: 'footer' as const, folio: false },
    ...(['header', 'footer'] as const).map((position) => ({
      ids: page.items
        .filter(
          (item) => numbered.has(item.id) && item.y < page.height / 2 === (position === 'header'),
        )
        .map((item) => item.id),
      position,
      folio: true,
    })),
  ];
  return selections.flatMap(({ ids, position, folio }) => {
    const selected = new Set(ids);
    const lines = buildLines(page.items.filter((item) => selected.has(item.id)));
    const items = lines.flatMap((line) => line.items);
    if (!items.length) return [];
    return [
      {
        id: `p${page.number}:running:${position}${folio ? ':folio' : ''}`,
        kind: 'paragraph' as const,
        sourcePage: page.number,
        sourceIds: items.map((item) => item.id),
        sourceSpans: sourceSpans(items),
        rect: union(items),
        text: joinLines(lines),
        rawText: lines.map((line) => line.text).join('\n'),
        fontSize: median(items.map((item) => item.fontSize)),
        confidence: 'high' as const,
        running: position,
        runningPageNumber: folio,
      },
    ];
  });
}

function withoutRunningContent(page: SourcePage, blocks: ReadingBlock[]): SourcePage {
  if (!blocks.length) return page;
  const ids = new Set(blocks.flatMap((block) => block.sourceIds));
  const items = page.items.filter((item) => !ids.has(item.id));
  const header = blocks.filter((block) => block.running === 'header');
  const footer = blocks.filter((block) => block.running === 'footer');
  const bodyTop = items.length ? Math.min(...items.map((item) => item.y)) : page.height;
  const bodyBottom = items.length ? Math.max(...items.map((item) => item.y + item.height)) : 0;
  const graphicRegions = page.graphicRegions.filter((region) => {
    if (region.width < page.width * 0.35 || region.height > 8) return true;
    if (
      header.length &&
      region.y >= Math.min(...header.map((block) => block.rect.y)) - 3 &&
      region.y + region.height <= bodyTop - 2
    )
      return false;
    if (
      footer.length &&
      region.y >= bodyBottom + 2 &&
      region.y + region.height <=
        Math.max(...footer.map((block) => block.rect.y + block.rect.height)) + 3
    )
      return false;
    return true;
  });
  return { ...page, items, graphicRegions };
}

export function analyzeDocument(source: SourceDocument): ReadingDocument {
  const running = detectRunningContent(source);
  const decorations = source.pages.map((page) => runningBlocks(page, running.get(page.number)));
  const inputs = source.pages.map((page, index) => withoutRunningContent(page, decorations[index]));
  const semantics = inputs.map(analyzePageSemantics);
  const labels = new Set(
    semantics.flatMap((page) =>
      page.blocks.flatMap((block) => (block.noteLabel ? [block.noteLabel] : [])),
    ),
  );
  const markerIds = new Map(
    inputs.map((page, index) => {
      const ids = noteMarkerIds(page, labels);
      semantics[index].referenceIds = ids;
      return [page.number, ids] as const;
    }),
  );
  const pages = inputs.map((page, index) => analyzePage(page, semantics[index]));
  const blocks = pages.flatMap((result, index) => {
    const page = source.pages[index];
    const fallback = result.blocks.find(
      (block) =>
        block.kind === 'sourceRegion' &&
        block.rect.x === 0 &&
        block.rect.y === 0 &&
        Math.abs(block.rect.width - page.width) < 0.1 &&
        Math.abs(block.rect.height - page.height) < 0.1,
    );
    return fallback && decorations[index].length
      ? pageFallback(page, fallback.reason ?? '원문 전체 보존')
      : [...result.blocks, ...decorations[index]];
  });
  return {
    schemaVersion: 1,
    sourceHash: source.hash,
    blocks,
    references: resolveNoteReferences(source, blocks, markerIds),
    warnings: [
      ...source.pages.flatMap((page) =>
        page.warnings.map((warning) => `${page.number}쪽: ${warning}`),
      ),
      ...pages.flatMap((page) => page.warnings),
    ],
  };
}

/** Corrections attach to stable source block ids, independent of output pagination. */
export function applyOverrides(reading: ReadingDocument, overrides: Overrides): ReadingDocument {
  const entries = reading.blocks
    .map((block, index) => {
      const override = overrides[block.id];
      if (override?.excluded) return undefined;
      if (override?.order !== undefined && (!Number.isFinite(override.order) || override.order < 0))
        throw new RangeError('블록 순서는 0 이상의 숫자여야 합니다.');
      return {
        block: {
          ...block,
          ...(override?.kind ? { kind: override.kind } : {}),
          ...(override?.text !== undefined ? { text: override.text } : {}),
        },
        order: override?.order ?? index,
        index,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
    .sort((a, b) => a.order - b.order || a.index - b.index);
  const unknown = Object.keys(overrides).filter(
    (id) => !reading.blocks.some((block) => block.id === id),
  );
  return {
    ...reading,
    blocks: entries.map((entry) => entry.block),
    warnings: [
      ...reading.warnings,
      ...(unknown.length
        ? [`현재 원문에 없는 보정 ${unknown.length}개는 적용하지 않았습니다.`]
        : []),
    ],
  };
}
