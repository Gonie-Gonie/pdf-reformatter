import type { BlockKind, LayoutConfig, LayoutDocument, LayoutPage, ReadingDocument } from './model';
import { validateConfig } from './config';
import { finiteRect } from './geometry';

export type MeasureText = (text: string, fontSize: number) => number;
const closingPunctuation =
  /^[,.;:!?\u3001\u3002\uff0c\uff0e\uff01\uff1f\u300d\u300f\u300b\u3009\uff09\]\)]/u;

function graphemes(text: string): string[] {
  const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
  return [...segmenter.segment(text)].map((segment) => segment.segment);
}

/** Measured wrapping supports CJK and unbroken URLs without changing source spelling. */
export function wrapText(
  text: string,
  width: number,
  size: number,
  measure: MeasureText,
): string[] {
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(size) || size <= 0)
    throw new RangeError('유효하지 않은 줄바꿈 크기입니다.');
  const checkedMeasure = (value: string) => {
    const measured = measure(value, size);
    if (!Number.isFinite(measured) || measured < 0)
      throw new RangeError('글꼴 폭 측정에 실패했습니다.');
    return measured;
  };
  const result: string[] = [];
  for (const paragraph of text.replace(/\r\n?/gu, '\n').split('\n')) {
    if (!paragraph.trim()) {
      if (result.length) result.push('');
      continue;
    }
    const tokens = paragraph.match(/[^ \t]+|[ \t]+/gu) ?? [];
    let line = '';
    const flush = () => {
      if (line.trim()) result.push(line.trimEnd());
      line = '';
    };
    for (const token of tokens) {
      if (!token.trim()) {
        if (line) line += token;
        continue;
      }
      const candidate = line + token;
      if (checkedMeasure(candidate) <= width + 0.001) {
        line = candidate;
        continue;
      }
      if (checkedMeasure(token) <= width + 0.001) {
        flush();
        line = token;
        continue;
      }
      // A long word may fill the previous line; never add or delete a hyphen.
      for (const cluster of graphemes(token)) {
        if (checkedMeasure(cluster) > width + 0.001)
          throw new RangeError('글자 하나가 본문 폭보다 큽니다. 페이지 폭 또는 여백을 조정하세요.');
        if (checkedMeasure(line + cluster) > width + 0.001) {
          if (closingPunctuation.test(cluster) && graphemes(line.trimEnd()).length > 1) {
            const previous = graphemes(line.trimEnd());
            const carry = previous.pop()!;
            line = previous.join('');
            flush();
            line = carry;
          } else flush();
        }
        line += cluster;
      }
    }
    flush();
  }
  return result;
}

function fontSize(kind: BlockKind, base: number): number {
  switch (kind) {
    case 'heading':
      return base * 1.35;
    case 'caption':
      return base * (11.6 / 13.2);
    case 'footnote':
      return base * (11.2 / 13.2);
    case 'reference':
      return base * (12 / 13.2);
    default:
      return base;
  }
}

export function layoutDocument(
  reading: ReadingDocument,
  rawConfig: LayoutConfig,
  measure: MeasureText,
): LayoutDocument {
  const config = validateConfig(rawConfig);
  const warnings = [...reading.warnings];
  const width = config.pageWidthPt - config.marginLeftPt - config.marginRightPt;
  // Sixteen points are reserved for a source/page footer, inside the bottom edge.
  const bottom = config.pageHeightPt - config.marginBottomPt - 16;
  const height = bottom - config.marginTopPt;
  const pages: LayoutPage[] = [];
  let page: LayoutPage;
  let y = config.marginTopPt;
  const newPage = () => {
    page = { number: pages.length + 1, placements: [], sourcePages: [] };
    pages.push(page);
    y = config.marginTopPt;
  };
  const addSource = (number: number) => {
    if (!page.sourcePages.includes(number)) page.sourcePages.push(number);
  };
  newPage();
  for (const block of reading.blocks) {
    if (block.kind === 'sourceRegion') {
      if (!finiteRect(block.rect))
        throw new RangeError(`${block.sourcePage}쪽 원문 영역의 크기가 잘못되었습니다.`);
      const mathScale =
        block.reason?.includes('수식') && block.fontSize > 0
          ? config.fontSizePt / block.fontSize
          : 1;
      const preferredScale = Math.min(mathScale, width / block.rect.width);
      let scale = Math.min(preferredScale, height / block.rect.height);
      if (!Number.isFinite(scale) || scale <= 0)
        throw new RangeError('원문 영역을 배치할 공간이 없습니다.');
      let regionHeight = block.rect.height * scale;
      if (y + regionHeight > bottom + 0.001 && page!.placements.length) newPage();
      if (regionHeight > bottom - y) {
        scale = (bottom - y) / block.rect.height;
        regionHeight = block.rect.height * scale;
      }
      const regionWidth = block.rect.width * scale;
      page!.placements.push({
        type: 'region',
        blockId: block.id,
        sourcePage: block.sourcePage,
        sourceRect: block.rect,
        x: config.marginLeftPt + (width - regionWidth) / 2,
        y,
        width: regionWidth,
        height: regionHeight,
      });
      addSource(block.sourcePage);
      if (scale < 0.65)
        warnings.push(
          `${block.sourcePage}쪽 원문 영역이 ${(scale * 100).toFixed(0)}%로 축소되었습니다. 내부 글자의 가독성을 확인하세요.`,
        );
      y += regionHeight + config.paragraphGapPt;
      continue;
    }
    if (!block.text.trim()) continue;
    const size = fontSize(block.kind, config.fontSizePt);
    const leading = Math.max(config.lineHeightPt * (size / config.fontSizePt), size * 1.15);
    const indent = block.kind === 'list' ? Math.min(size, width * 0.08) : 0;
    const lines = wrapText(block.text, width - indent, size, measure);
    if (!lines.length) continue;
    if (leading > height + 0.001)
      throw new RangeError('선택한 글자 크기와 행간을 배치할 페이지 높이가 부족합니다.');
    if (
      block.kind === 'heading' &&
      page!.placements.length &&
      y + leading * (lines.length + 1) > bottom
    )
      newPage();
    let offset = 0;
    while (offset < lines.length) {
      let available = Math.floor((bottom - y + 0.001) / leading);
      if (available <= 0) {
        newPage();
        continue;
      }
      let count = Math.min(lines.length - offset, available);
      const remaining = lines.length - offset;
      // Keep at least two paragraph lines together when the page can hold them.
      if (remaining > count && count === 1 && page!.placements.length && height >= leading * 2) {
        newPage();
        continue;
      }
      if (remaining - count === 1 && count >= 3) count--;
      available = count;
      for (let index = 0; index < available; index++) {
        const text = lines[offset + index];
        if (text) {
          page!.placements.push({
            type: 'text',
            blockId: block.id,
            sourcePage: block.sourcePage,
            text,
            fontSize: size,
            x: config.marginLeftPt + indent,
            y,
            width: measure(text, size),
            height: leading,
          });
          addSource(block.sourcePage);
        }
        y += leading;
      }
      offset += available;
      if (offset < lines.length) newPage();
    }
    y += config.paragraphGapPt;
  }
  if (pages.length > 1 && !pages.at(-1)!.placements.length) pages.pop();
  if (pages.length === 1 && !pages[0].placements.length)
    throw new RangeError('출력할 내용이 없습니다. 제외한 블록을 확인하세요.');
  for (const output of pages) {
    output.sourcePages.sort((a, b) => a - b);
    for (const placement of output.placements) {
      if (
        !finiteRect(placement) ||
        placement.x < config.marginLeftPt - 0.01 ||
        placement.y < config.marginTopPt - 0.01 ||
        placement.x + placement.width > config.pageWidthPt - config.marginRightPt + 0.01 ||
        placement.y + placement.height > bottom + 0.01
      ) {
        throw new RangeError(`출력 ${output.number}쪽의 배치가 본문 영역을 벗어납니다.`);
      }
    }
  }
  return { pages, config, warnings: [...new Set(warnings)] };
}
