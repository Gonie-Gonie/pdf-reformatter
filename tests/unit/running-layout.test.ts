import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/core/config';
import { findLayoutAnchor, layoutDocument } from '../../src/core/layout';
import type { LayoutConfig, ReadingBlock, ReadingDocument } from '../../src/core/model';

const config: LayoutConfig = {
  ...DEFAULT_CONFIG,
  pageWidthPt: 260,
  pageHeightPt: 170,
  marginTopPt: 24,
  marginBottomPt: 24,
  marginLeftPt: 12,
  marginRightPt: 12,
  fontSizePt: 12,
  lineHeightPt: 20,
};
const measure = (text: string, size: number) => [...text].length * size * 0.5;

function block(id: string, text: string, sourcePage = 1): ReadingBlock {
  return {
    id,
    text,
    rawText: text,
    kind: 'paragraph',
    sourcePage,
    sourceIds: [id],
    rect: { x: 36, y: 40, width: 300, height: 12 },
    fontSize: 12,
    confidence: 'high',
  };
}
function document(blocks: ReadingBlock[]): ReadingDocument {
  return { schemaVersion: 1, sourceHash: 'book', blocks, warnings: [] };
}
function body(id: string, sourcePage = 1): ReadingBlock {
  return block(id, 'The original book body remains reflowable prose. '.repeat(18), sourcePage);
}

describe('running book content layout', () => {
  it('moves a figure and its following nearby caption together when the pair fits a page', () => {
    const filler = block('filler', 'lead one\nlead two\nlead three');
    const figure: ReadingBlock = {
      ...block('figure', ''),
      kind: 'sourceRegion',
      rect: { x: 40, y: 100, width: 200, height: 20 },
    };
    const caption: ReadingBlock = {
      ...block('caption', 'Figure 2.1 A compact caption.'),
      kind: 'caption',
      rect: { x: 40, y: 126, width: 200, height: 12 },
    };
    const marker: ReadingBlock = {
      ...block('marker', '7'),
      kind: 'lineNumber',
      anchor: { blockId: figure.id },
    };
    const layout = layoutDocument(
      document([
        filler,
        figure,
        { ...block('header', 'The current chapter'), running: 'header' },
        marker,
        caption,
      ]),
      config,
      measure,
    );
    const figurePage = layout.pages.find((page) =>
      page.placements.some((item) => item.blockId === figure.id),
    )!;
    const captionPage = layout.pages.find((page) =>
      page.placements.some((item) => item.blockId === caption.id),
    )!;
    expect(figurePage.number).toBe(2);
    expect(captionPage.number).toBe(figurePage.number);
    const placedFigure = figurePage.placements.find((item) => item.blockId === figure.id)!;
    const placedCaption = captionPage.placements.find((item) => item.blockId === caption.id)!;
    expect(placedCaption.y).toBeGreaterThan(placedFigure.y + placedFigure.height);
  });

  it('allows an oversized figure-caption pair to split without moving or rasterizing its text', () => {
    const figure: ReadingBlock = {
      ...block('figure', ''),
      kind: 'sourceRegion',
      rect: { x: 40, y: 100, width: 200, height: 80 },
    };
    const caption: ReadingBlock = {
      ...block(
        'caption',
        'Figure 2.1 This caption has enough explanatory words to take several complete lines.',
      ),
      kind: 'caption',
      rect: { x: 40, y: 186, width: 200, height: 12 },
    };
    const layout = layoutDocument(
      document([block('filler', 'lead one\nlead two\nlead three'), figure, caption]),
      config,
      measure,
    );
    const figurePage = layout.pages.find((page) =>
      page.placements.some((item) => item.blockId === figure.id),
    )!;
    const captionPages = layout.pages.filter((page) =>
      page.placements.some((item) => item.blockId === caption.id),
    );
    expect(figurePage.number).toBe(2);
    expect(captionPages[0].number).toBeGreaterThan(figurePage.number);
    const captionText = captionPages
      .flatMap((page) => page.placements)
      .filter((item) => item.blockId === caption.id);
    expect(captionText.every((item) => item.type === 'text')).toBe(true);
    expect(
      captionText
        .map((item) => (item.type === 'text' ? item.text.replace(/\s/gu, '') : ''))
        .join(''),
    ).toBe(caption.text.replace(/\s/gu, ''));
  });

  it.each([
    { sourcePage: 2, y: 126 },
    { sourcePage: 1, y: 300 },
  ])(
    'does not attach an unrelated caption from source page $sourcePage at y=$y',
    ({ sourcePage, y }) => {
      const figure: ReadingBlock = {
        ...block('figure', ''),
        kind: 'sourceRegion',
        rect: { x: 40, y: 100, width: 200, height: 20 },
      };
      const caption: ReadingBlock = {
        ...block('caption', 'Figure 2.1 A compact caption.', sourcePage),
        kind: 'caption',
        rect: { x: 40, y, width: 200, height: 12 },
      };
      const layout = layoutDocument(
        document([block('filler', 'lead one\nlead two\nlead three'), figure, caption]),
        config,
        measure,
      );
      expect(layout.pages[0].placements.some((item) => item.blockId === figure.id)).toBe(true);
      expect(layout.pages[0].placements.some((item) => item.blockId === caption.id)).toBe(false);
    },
  );

  it('repeats titles in page margins without flowing them or original folios into prose', () => {
    const prose = body('body');
    const reading = document([
      { ...block('header', 'A chapter title'), running: 'header' },
      { ...block('old-page', '27'), running: 'header', runningPageNumber: true },
      prose,
      { ...block('footer', 'Book edition'), running: 'footer' },
    ]);
    const layout = layoutDocument(reading, config, measure);

    expect(layout.pages.length).toBeGreaterThan(1);
    for (const page of layout.pages) {
      const headers = page.placements.filter((item) => item.decoration === 'runningHeader');
      const footers = page.placements.filter((item) => item.decoration === 'runningFooter');
      expect(headers).toHaveLength(1);
      expect(footers).toHaveLength(1);
      expect(headers[0].y + headers[0].height).toBeLessThan(config.marginTopPt);
      const content = page.placements.filter((item) => !item.decoration);
      expect(content.every((item) => item.blockId === prose.id)).toBe(true);
      expect(footers[0].y).toBeGreaterThanOrEqual(
        Math.max(...content.map((item) => item.y + item.height)),
      );
      expect(page.placements.some((item) => item.blockId === 'old-page')).toBe(false);
    }
    expect(
      layout.pages
        .flatMap((page) => page.placements)
        .filter((item) => !item.decoration && item.type === 'text')
        .map((item) => (item.type === 'text' ? item.text.replace(/\s/gu, '') : ''))
        .join(''),
    ).toBe(prose.text.replace(/\s/gu, ''));
  });

  it('chooses the header matching the first body content on each output page', () => {
    const reading = document([
      { ...block('header-one', 'Chapter one', 1), running: 'header' },
      body('first', 1),
      { ...block('header-two', 'Chapter two', 2), running: 'header' },
      body('second', 2),
    ]);
    const layout = layoutDocument(reading, config, measure);
    const visited = new Set<number>();
    for (const page of layout.pages) {
      const first = page.placements.find((item) => !item.decoration)!;
      visited.add(first.sourcePage);
      const header = page.placements.find((item) => item.decoration === 'runningHeader')!;
      expect(header.blockId).toBe(first.sourcePage === 1 ? 'header-one' : 'header-two');
    }
    expect([...visited]).toEqual([1, 2]);
  });

  it('does not carry a chapter header onto another source page lacking that title', () => {
    const reading = document([
      { ...block('header', 'An earlier chapter', 1), running: 'header' },
      body('first', 1),
      body('untitled', 2),
    ]);
    const layout = layoutDocument(reading, config, measure);
    const untitled = layout.pages.filter(
      (page) => page.placements.find((item) => !item.decoration)?.sourcePage === 2,
    );
    expect(untitled.length).toBeGreaterThan(0);
    expect(
      untitled.every(
        (page) => !page.placements.some((item) => item.decoration === 'runningHeader'),
      ),
    ).toBe(true);
  });

  it('keeps zero-margin running titles clear of body and the generated output counter', () => {
    const narrowMargins = { ...config, marginTopPt: 0, marginBottomPt: 0 };
    const layout = layoutDocument(
      document([
        { ...block('header', 'A chapter title'), running: 'header' },
        body('body'),
        { ...block('footer', 'Book edition'), running: 'footer' },
      ]),
      narrowMargins,
      measure,
    );
    const counterTop = narrowMargins.pageHeightPt - 5 - 7;
    for (const page of layout.pages) {
      const header = page.placements.find((item) => item.decoration === 'runningHeader')!;
      const footer = page.placements.find((item) => item.decoration === 'runningFooter')!;
      const content = page.placements.filter((item) => !item.decoration);
      expect(header.y).toBeGreaterThanOrEqual(0);
      expect(header.y + header.height).toBeLessThan(Math.min(...content.map((item) => item.y)));
      expect(footer.y).toBeGreaterThan(Math.max(...content.map((item) => item.y + item.height)));
      expect(footer.y + footer.height).toBeLessThan(counterTop);
      for (const item of page.placements) {
        expect(item.x).toBeGreaterThanOrEqual(0);
        expect(item.y).toBeGreaterThanOrEqual(0);
        expect(item.x + item.width).toBeLessThanOrEqual(config.pageWidthPt);
        expect(item.y + item.height).toBeLessThanOrEqual(config.pageHeightPt);
      }
    }
  });

  it('retains rasterized running titles as margin decorations and excludes them from anchors', () => {
    const header: ReadingBlock = {
      ...block('header', 'An unsupported title'),
      kind: 'sourceRegion',
      rect: { x: 40, y: 20, width: 180, height: 18 },
      running: 'header',
    };
    const reading = document([header, body('body')]);
    const layout = layoutDocument(reading, config, measure);
    const placed = layout.pages[0].placements.find((item) => item.blockId === header.id)!;
    expect(placed.type).toBe('region');
    expect(placed.decoration).toBe('runningHeader');
    expect(placed.width / placed.height).toBeCloseTo(header.rect.width / header.rect.height);
    expect(placed.y + placed.height).toBeLessThan(config.marginTopPt);
    expect(findLayoutAnchor(layout, reading, { blockId: header.id }, measure)).toBeUndefined();
  });

  it('fits long titles on a single line without losing their text', () => {
    const text = 'A long chapter title with several meaningful words '.repeat(5).trim();
    const layout = layoutDocument(
      document([
        { ...block('header', text), running: 'header' },
        block('body', 'One paragraph of body text.'),
      ]),
      config,
      measure,
    );
    const header = layout.pages[0].placements.find((item) => item.decoration === 'runningHeader')!;
    expect(header.type).toBe('text');
    if (header.type !== 'text') throw new Error('Expected a text running header');
    expect(header.text).toBe(text);
    expect(header.fontSize).toBeGreaterThan(0);
    expect(header.fontSize).toBeLessThanOrEqual(8);
    expect(header.width).toBeLessThanOrEqual(
      config.pageWidthPt - config.marginLeftPt - config.marginRightPt,
    );
    expect(header.height).toBeLessThanOrEqual(10);
  });

  it('does not change body pagination for documents containing only original folios', () => {
    const prose = body('body');
    const plain = layoutDocument(document([prose]), config, measure);
    const numbered = layoutDocument(
      document([{ ...block('folio', '27'), running: 'footer', runningPageNumber: true }, prose]),
      config,
      measure,
    );
    expect(numbered.pages).toEqual(plain.pages);
  });
});
