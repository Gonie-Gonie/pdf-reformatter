import type {
  BlockAnchor,
  BlockKind,
  LayoutConfig,
  LayoutDocument,
  LayoutPage,
  Placement,
  ReadingBlock,
  ReadingDocument,
  Rect,
} from './model';
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

function normalized(text: string): string {
  return text.normalize('NFKC').replace(/[\s\u00ad]/gu, '');
}

function characterAt(text: string, offset: number): { prefix: string; character: string } {
  let prefix = '';
  let consumed = 0;
  for (const character of graphemes(text)) {
    const length = normalized(character).length;
    if (length && consumed + length > offset) return { prefix, character };
    prefix += character;
    consumed += length;
  }
  return { prefix: text, character: '' };
}

function placementRect(placement: Placement): Rect {
  return { x: placement.x, y: placement.y, width: placement.width, height: placement.height };
}

interface AnchorIndex {
  reading: ReadingDocument;
  blocks: Map<string, ReadingBlock>;
  placements: Map<string, { page: number; placement: Placement }[]>;
}
const anchorIndices = new WeakMap<LayoutDocument, AnchorIndex>();

function anchorIndex(layout: LayoutDocument, reading: ReadingDocument): AnchorIndex {
  const cached = anchorIndices.get(layout);
  if (cached?.reading === reading) return cached;
  const placements: AnchorIndex['placements'] = new Map();
  for (const page of layout.pages) {
    for (const placement of page.placements) {
      if (placement.decoration) continue;
      const entries = placements.get(placement.blockId) ?? [];
      entries.push({ page: page.number, placement });
      placements.set(placement.blockId, entries);
    }
  }
  const index = {
    reading,
    blocks: new Map(reading.blocks.map((block) => [block.id, block])),
    placements,
  };
  anchorIndices.set(layout, index);
  return index;
}

/** Locate an original character/object after wrapping, including starts in the middle of a line. */
export function findLayoutAnchor(
  layout: LayoutDocument,
  reading: ReadingDocument,
  anchor: BlockAnchor,
  measure: MeasureText,
): { page: number; rect: Rect } | undefined {
  const index = anchorIndex(layout, reading);
  const block = index.blocks.get(anchor.blockId);
  if (!block || block.running) return undefined;
  const placements = index.placements.get(block.id) ?? [];
  if (!placements.length) return undefined;
  const span = block.sourceSpans?.find((item) => item.sourceId === anchor.sourceId);
  const offset = span
    ? span.start + Math.min(Math.max(0, anchor.offset ?? 0), Math.max(0, span.end - span.start - 1))
    : Math.max(0, anchor.offset ?? 0);
  for (const item of placements) {
    const placement = item.placement;
    if (placement.type === 'region') {
      if (!span || !finiteRect(span.rect))
        return { page: item.page, rect: placementRect(placement) };
      const source = placement.sourceRect;
      const left = Math.max(source.x, span.rect.x);
      const top = Math.max(source.y, span.rect.y);
      const right = Math.min(source.x + source.width, span.rect.x + span.rect.width);
      const bottom = Math.min(source.y + source.height, span.rect.y + span.rect.height);
      if (right <= left || bottom <= top) continue;
      return {
        page: item.page,
        rect: {
          x: placement.x + ((left - source.x) * placement.width) / source.width,
          y: placement.y + ((top - source.y) * placement.height) / source.height,
          width: ((right - left) * placement.width) / source.width,
          height: ((bottom - top) * placement.height) / source.height,
        },
      };
    }
    if (placement.textStart === undefined || placement.textEnd === undefined) continue;
    if (offset < placement.textStart || offset >= placement.textEnd) continue;
    const located = characterAt(placement.text, offset - placement.textStart);
    const x = placement.x + measure(located.prefix, placement.fontSize);
    return {
      page: item.page,
      rect: {
        x,
        y: placement.y,
        width: Math.max(
          0.1,
          Math.min(
            placement.x + placement.width - x,
            measure(located.character, placement.fontSize),
          ),
        ),
        height: Math.min(placement.height, placement.fontSize),
      },
    };
  }
  const first = placements[0];
  return { page: first.page, rect: placementRect(first.placement) };
}

function placeLineNumbers(
  layout: LayoutDocument,
  reading: ReadingDocument,
  measure: MeasureText,
  gutter: number,
  numberSize: number,
  bottom: number,
): void {
  const { config } = layout;
  const index = anchorIndex(layout, reading);
  interface Label {
    block: ReadingBlock;
    rect: Rect;
    placement: Placement;
  }
  const groups = new Map<string, { page: number; labels: Label[] }>();
  for (const block of reading.blocks) {
    if (block.kind !== 'lineNumber' || block.running) continue;
    const located = block.anchor && findLayoutAnchor(layout, reading, block.anchor, measure);
    if (!located)
      throw new RangeError(`${block.sourcePage}쪽 줄번호의 시작 위치를 찾지 못했습니다.`);
    const target = index.placements
      .get(block.anchor!.blockId)
      ?.find(
        (entry) =>
          entry.page === located.page &&
          located.rect.y >= entry.placement.y - 0.1 &&
          located.rect.y < entry.placement.y + entry.placement.height + 0.1,
      )?.placement;
    if (!target) throw new RangeError(`${block.sourcePage}쪽 줄번호의 본문을 찾지 못했습니다.`);
    const key = `${located.page}:${located.rect.y.toFixed(3)}`;
    const group = groups.get(key) ?? { page: located.page, labels: [] };
    group.labels.push({ block, rect: located.rect, placement: target });
    groups.set(key, group);
  }
  const gap = Math.min(4, gutter * 0.12);
  const room = Math.max(0.1, gutter - gap * 2);
  const add = (page: LayoutPage, label: Label, x: number, y: number, size: number) => {
    if (!Number.isFinite(size) || size < 3)
      throw new RangeError('페이지 폭을 줄이거나 글자를 키워 줄번호가 겹치지 않게 하세요.');
    page.placements.push({
      type: 'text',
      blockId: label.block.id,
      sourcePage: label.block.sourcePage,
      text: label.block.text,
      fontSize: size,
      decoration: 'lineNumber',
      x,
      y: Math.min(bottom - size, Math.max(config.marginTopPt, y)),
      width: measure(label.block.text, size),
      height: size,
    });
    if (!page.sourcePages.includes(label.block.sourcePage))
      page.sourcePages.push(label.block.sourcePage);
  };
  for (const group of groups.values()) {
    const page = layout.pages.find((item) => item.number === group.page)!;
    const labels = group.labels.sort((a, b) => a.rect.x - b.rect.x);
    const first = labels[0];
    const baseline =
      first.rect.y +
      (first.placement.type === 'text'
        ? first.placement.fontSize
        : Math.min(config.fontSizePt, first.rect.height));
    const raised = labels.slice(1).map((label) => {
      const target = label.placement;
      if (target.type !== 'text') return undefined;
      const leading = Math.max(
        (config.lineHeightPt * target.fontSize) / config.fontSizePt,
        target.fontSize * 1.15,
      );
      const band = leading - target.height;
      if (band < 5.5) return undefined;
      const size = Math.min(numberSize, 6.5, band - 0.5);
      const width = measure(label.block.text, size);
      const x = Math.min(label.rect.x, config.pageWidthPt - config.marginRightPt - width);
      return { label, size, width, x, y: target.y - band };
    });
    const canRaise = raised.every(
      (item, position) =>
        item !== undefined &&
        item.x >= config.marginLeftPt + gutter &&
        item.y >= config.marginTopPt - 0.01 &&
        (position === 0 || item.x >= raised[position - 1]!.x + raised[position - 1]!.width + 1),
    );
    if (labels.length === 1 || canRaise) {
      const desired = measure(first.block.text, numberSize);
      const size = desired > room ? (numberSize * room) / desired : numberSize;
      const width = measure(first.block.text, size);
      add(page, first, config.marginLeftPt + gutter - gap - width, baseline - size, size);
      for (const item of raised) if (item) add(page, item.label, item.x, item.y, item.size);
    } else {
      // A tight leading or colliding inline starts share the gutter; every label stays on its row.
      const spacing = Math.min(2, room / (labels.length * 3));
      const desired = labels.reduce((sum, label) => sum + measure(label.block.text, numberSize), 0);
      const size = Math.min(
        numberSize,
        (numberSize * (room - spacing * (labels.length - 1))) / Math.max(0.1, desired),
      );
      const total =
        labels.reduce((sum, label) => sum + measure(label.block.text, size), 0) +
        spacing * (labels.length - 1);
      let x = config.marginLeftPt + gutter - gap - total;
      for (const label of labels) {
        add(page, label, x, baseline - size, size);
        x += measure(label.block.text, size) + spacing;
      }
    }
  }
}

function runningTitles(reading: ReadingDocument): Map<
  number,
  {
    header: ReadingBlock[];
    footer: ReadingBlock[];
  }
> {
  const bySource = new Map<number, { header: ReadingBlock[]; footer: ReadingBlock[] }>();
  for (const block of reading.blocks) {
    if (!block.running || block.runningPageNumber) continue;
    if (block.kind === 'sourceRegion' ? !finiteRect(block.rect) : !block.text.trim()) continue;
    const entries = bySource.get(block.sourcePage) ?? { header: [], footer: [] };
    entries[block.running].push(block);
    bySource.set(block.sourcePage, entries);
  }
  return bySource;
}

function placeRunningContent(
  layout: LayoutDocument,
  titles: ReturnType<typeof runningTitles>,
  measure: MeasureText,
  top: number,
  bottom: number,
): void {
  const { config } = layout;
  const width = config.pageWidthPt - config.marginLeftPt - config.marginRightPt;
  const height = 10;
  const add = (page: LayoutPage, blocks: ReadingBlock[], position: 'header' | 'footer') => {
    if (!blocks.length) return;
    const desired = blocks.map((block) =>
      block.kind === 'sourceRegion'
        ? (block.rect.width * height) / block.rect.height
        : measure(block.text.replace(/\s+/gu, ' ').trim(), 8),
    );
    if (desired.some((value) => !Number.isFinite(value) || value <= 0))
      throw new RangeError('머릿말·꼬릿말의 크기를 계산하지 못했습니다.');
    const gap = Math.min(6, width / Math.max(2, blocks.length * 4));
    const available = width - gap * (blocks.length - 1);
    const total = desired.reduce((sum, value) => sum + value, 0);
    const scale = Math.min(1, available / total);
    let x = config.marginLeftPt;
    const y = position === 'header' ? Math.max(0, (top - height) / 2) : bottom + 2;
    for (const [index, block] of blocks.entries()) {
      const decoration =
        position === 'header' ? ('runningHeader' as const) : ('runningFooter' as const);
      if (block.kind === 'sourceRegion') {
        const regionHeight = height * scale;
        page.placements.push({
          type: 'region',
          blockId: block.id,
          sourcePage: block.sourcePage,
          sourceRect: block.rect,
          decoration,
          x,
          y: y + (height - regionHeight) / 2,
          width: desired[index] * scale,
          height: regionHeight,
        });
      } else {
        const text = block.text.replace(/\s+/gu, ' ').trim();
        const size = 8 * scale;
        const textHeight = size * 1.2;
        page.placements.push({
          type: 'text',
          blockId: block.id,
          sourcePage: block.sourcePage,
          text,
          fontSize: size,
          decoration,
          x,
          y: y + (height - textHeight) / 2,
          width: measure(text, size),
          height: textHeight,
        });
      }
      x += desired[index] * scale + gap;
    }
  };
  for (const page of layout.pages) {
    const first = page.placements.find((placement) => !placement.decoration);
    if (!first) continue;
    const entries = titles.get(first.sourcePage);
    if (!entries) continue;
    add(page, entries.header, 'header');
    add(page, entries.footer, 'footer');
  }
}

function followingCaption(blocks: ReadingBlock[], index: number): ReadingBlock | undefined {
  const region = blocks[index];
  for (let next = index + 1; next < blocks.length; next++) {
    const caption = blocks[next];
    if (caption.running || caption.kind === 'lineNumber') continue;
    if (
      caption.kind !== 'caption' ||
      caption.sourcePage !== region.sourcePage ||
      !caption.text.trim()
    )
      return undefined;
    const gap = caption.rect.y - region.rect.y - region.rect.height;
    return gap >= -2 && gap <= Math.max(1, caption.fontSize) * 4 ? caption : undefined;
  }
  return undefined;
}

export function layoutDocument(
  reading: ReadingDocument,
  rawConfig: LayoutConfig,
  measure: MeasureText,
): LayoutDocument {
  const config = validateConfig(rawConfig);
  const warnings = [...reading.warnings];
  const fullWidth = config.pageWidthPt - config.marginLeftPt - config.marginRightPt;
  const titles = runningTitles(reading);
  const hasHeader = [...titles.values()].some((entries) => entries.header.length);
  const hasFooter = [...titles.values()].some((entries) => entries.footer.length);
  const lineNumbers = reading.blocks.filter(
    (block) => block.kind === 'lineNumber' && !block.running,
  );
  const numberSize = Math.max(4, Math.min(8, config.fontSizePt * 0.6));
  const numberGutter = lineNumbers.length
    ? Math.min(
        fullWidth * 0.22,
        lineNumbers.reduce(
          (largest, block) => Math.max(largest, measure(block.text, numberSize) * 2.5 + 8),
          14,
        ),
      )
    : 0;
  const numberedBlocks = new Set(lineNumbers.map((block) => block.anchor?.blockId));
  const width = fullWidth - numberGutter;
  const left = config.marginLeftPt + numberGutter;
  // The existing footer strip holds running text above the generated output counter.
  const top = hasHeader ? Math.max(14, config.marginTopPt) : config.marginTopPt;
  const footerExtra = hasFooter ? Math.max(0, 12 - config.marginBottomPt) : 0;
  const bottom = config.pageHeightPt - config.marginBottomPt - 16 - footerExtra;
  const height = bottom - top;
  const pages: LayoutPage[] = [];
  let page: LayoutPage;
  let y = top;
  const newPage = () => {
    page = { number: pages.length + 1, placements: [], sourcePages: [] };
    pages.push(page);
    y = top;
  };
  const addSource = (number: number) => {
    if (!page.sourcePages.includes(number)) page.sourcePages.push(number);
  };
  newPage();
  for (const [blockIndex, block] of reading.blocks.entries()) {
    if (block.kind === 'lineNumber' || block.running) continue;
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
      const caption = followingCaption(reading.blocks, blockIndex);
      if (caption) {
        const size = fontSize(caption.kind, config.fontSizePt);
        const leading = Math.max((config.lineHeightPt * size) / config.fontSizePt, size * 1.15);
        const captionHeight = wrapText(caption.text, width, size, measure).length * leading;
        const pairHeight = regionHeight + config.paragraphGapPt + captionHeight;
        if (
          pairHeight <= height + 0.001 &&
          y + pairHeight > bottom + 0.001 &&
          page!.placements.length
        )
          newPage();
      }
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
        x: left + (width - regionWidth) / 2,
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
      (block.keepTogether || block.semantic === 'note') &&
      lines.length * leading <= height &&
      y + lines.length * leading > bottom &&
      page!.placements.length
    )
      newPage();
    if (
      block.kind === 'heading' &&
      page!.placements.length &&
      y + leading * (lines.length + 1) > bottom
    )
      newPage();
    let offset = 0;
    let textOffset = 0;
    const spare = numberedBlocks.has(block.id)
      ? Math.min(7, Math.max(0, leading - size * 1.05))
      : 0;
    const numberBand = spare >= 5.5 ? spare : 0;
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
            textStart: textOffset,
            textEnd: textOffset + normalized(text).length,
            x: left + indent,
            y: y + numberBand,
            width: measure(text, size),
            height: leading - numberBand,
          });
          addSource(block.sourcePage);
        }
        textOffset += normalized(text).length;
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
  const layout = { pages, config, warnings: [...new Set(warnings)] };
  placeLineNumbers(layout, reading, measure, numberGutter, numberSize, bottom);
  placeRunningContent(layout, titles, measure, top, bottom);
  for (const output of pages) {
    output.sourcePages.sort((a, b) => a - b);
    for (const placement of output.placements) {
      const running =
        placement.decoration === 'runningHeader' || placement.decoration === 'runningFooter';
      if (
        !finiteRect(placement) ||
        placement.x < (running ? 0 : config.marginLeftPt) - 0.01 ||
        placement.y < (running ? 0 : config.marginTopPt) - 0.01 ||
        placement.x + placement.width >
          config.pageWidthPt - (running ? 0 : config.marginRightPt) + 0.01 ||
        placement.y + placement.height > (running ? config.pageHeightPt : bottom) + 0.01
      ) {
        throw new RangeError(`출력 ${output.number}쪽의 배치가 본문 영역을 벗어납니다.`);
      }
    }
  }
  return layout;
}
