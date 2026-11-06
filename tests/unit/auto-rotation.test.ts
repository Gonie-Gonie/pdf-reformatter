import { describe, expect, it } from 'vitest';
import { fitRotatedRegion } from '../../src/core/auto-rotation';
import { DEFAULT_CONFIG } from '../../src/core/config';
import { layoutDocument } from '../../src/core/layout';
import type { ReadingBlock, ReadingDocument, SourcePage } from '../../src/core/model';

const figure: ReadingBlock = {
  id: 'figure',
  kind: 'sourceRegion',
  sourcePage: 1,
  sourceIds: ['label'],
  rect: { x: 50, y: 60, width: 150, height: 500 },
  text: '',
  rawText: '',
  fontSize: 10,
  confidence: 'high',
  reason: '그림·표·벡터 도형을 원문 모양으로 보존',
};
const measure = (text: string, size: number) => text.length * size * 0.5;
const config = {
  ...DEFAULT_CONFIG,
  pageWidthPt: 440,
  pageHeightPt: 256,
  marginLeftPt: 20,
  marginRightPt: 20,
  marginTopPt: 20,
  marginBottomPt: 20,
};
const document = (blocks = [figure]): ReadingDocument => ({
  schemaVersion: 1,
  sourceHash: 'rotation',
  blocks,
  warnings: [],
});
const sourcePage: SourcePage = {
  number: 1,
  width: 600,
  height: 800,
  rotation: 0,
  items: [],
  graphicRegions: [],
  warnings: [],
};

describe('large figure and table auto rotation', () => {
  it('rotates only when the displayed area at least doubles', () => {
    const fit = fitRotatedRegion(figure, 400, 200)!;
    expect(fit).toEqual({ rotation: 90, scale: 0.8 });
    expect((fit.scale / 0.4) ** 2).toBe(4);
    const squareRootTwo = Math.SQRT2;
    expect(fitRotatedRegion(figure, 200 * squareRootTwo, 200)?.rotation).toBe(90);
    expect(fitRotatedRegion(figure, 282, 200)).toBeUndefined();
  });

  it.each([
    { rect: { ...figure.rect, width: 59 } },
    { rect: { ...figure.rect, width: 60, height: 143 } },
    { reason: '수식의 문자·첨자·분수선을 함께 원문 모양으로 보존' },
    { reason: '코드의 줄바꿈과 들여쓰기를 원문 모양으로 보존' },
    { reason: '그림과 본문이 겹치는 페이지 전체를 보존' },
    { semantic: 'toc' as const },
    { running: 'header' as const },
    { reason: undefined },
  ])('leaves small or nonfigure regions untouched: %j', (change) => {
    expect(fitRotatedRegion({ ...figure, ...change }, 400, 200)).toBeUndefined();
  });

  it('excludes full-page crops even if their reason mentions a figure', () => {
    const fullPage = { ...figure, rect: { x: 0, y: 0, width: 600, height: 800 } };
    expect(fitRotatedRegion(fullPage, 600, 200, 0, sourcePage)).toBeUndefined();
  });

  it('requires meaningful page occupancy and a readable short side', () => {
    expect(fitRotatedRegion(figure, 1800, 200)).toBeUndefined();
    expect(
      fitRotatedRegion({ ...figure, rect: { ...figure.rect, width: 60, height: 700 } }, 400, 200),
    ).toBeUndefined();
    expect(
      fitRotatedRegion({ ...figure, rect: { ...figure.rect, width: 100, height: 300 } }, 1000, 200),
    ).toBeUndefined();
  });

  it('turns sideways table text upright using the dominant source orientation', () => {
    const item = {
      id: 'label',
      text: 'A substantial table heading',
      x: 70,
      y: 70,
      width: 12,
      height: 200,
      fontSize: 10,
      fontName: 'serif',
      hasEOL: false,
    };
    const table = { ...figure, semantic: 'table' as const, reason: undefined };
    for (const rotation of [90, 450])
      expect(
        fitRotatedRegion(table, 400, 200, 0, { ...sourcePage, items: [{ ...item, rotation }] })
          ?.rotation,
      ).toBe(270);
    expect(
      fitRotatedRegion(table, 400, 200, 0, {
        ...sourcePage,
        items: [{ ...item, text: '123 456 789', rotation: 90 }],
      })?.rotation,
    ).toBe(270);
    for (const rotation of [-90, 270, 0])
      expect(
        fitRotatedRegion(table, 400, 200, 0, { ...sourcePage, items: [{ ...item, rotation }] })
          ?.rotation,
      ).toBe(90);
    expect(
      fitRotatedRegion(table, 400, 200, 0, {
        ...sourcePage,
        items: [{ ...item, id: 'not-part-of-this-table', rotation: 90 }],
      })?.rotation,
    ).toBe(90);
  });

  it('keeps the original crop, flow order and caption while fitting the larger rotated object', () => {
    const lead: ReadingBlock = {
      ...figure,
      id: 'lead',
      kind: 'paragraph',
      text: 'lead one\nlead two\nlead three\nlead four',
    };
    const caption: ReadingBlock = {
      ...figure,
      id: 'caption',
      kind: 'caption',
      text: 'Figure 1. A short caption.',
      rect: { ...figure.rect, y: 570, height: 12 },
    };
    const tail: ReadingBlock = { ...lead, id: 'tail', text: 'The following prose stays upright.' };
    const layout = layoutDocument(document([lead, figure, caption, tail]), config, measure);
    const page = layout.pages.find((entry) =>
      entry.placements.some((item) => item.blockId === figure.id),
    )!;
    const placed = page.placements.find((item) => item.blockId === figure.id)!;
    expect(page.number).toBe(2);
    expect(placed.type === 'region' && placed.rotation).toBe(90);
    expect(placed.type === 'region' && placed.sourceRect).toEqual(figure.rect);
    expect(placed.width).toBe(400);
    expect(placed.height).toBe(120);
    expect(page.placements.find((item) => item.blockId === caption.id)?.type).toBe('text');
    const order = layout.pages.flatMap((entry) => entry.placements).map((item) => item.blockId);
    expect(order.indexOf('lead')).toBeLessThan(order.indexOf('figure'));
    expect(order.indexOf('figure')).toBeLessThan(order.indexOf('caption'));
    expect(order.indexOf('caption')).toBeLessThan(order.indexOf('tail'));
    const alone = layoutDocument(document(), config, measure).pages[0].placements[0];
    expect([placed.width, placed.height]).toEqual([alone.width, alone.height]);
  });

  it('reserves caption space and declines a rotation whose resulting benefit is too small', () => {
    expect(fitRotatedRegion(figure, 400, 200, 100)).toEqual({ rotation: 90, scale: 2 / 3 });
    expect(fitRotatedRegion(figure, 400, 200, 120)).toBeUndefined();
    expect(fitRotatedRegion(figure, 400, 200, 220)).toBeUndefined();
  });

  it('preserves an existing same-page caption instead of enlarging the figure at its expense', () => {
    const wide = { ...figure, rect: { ...figure.rect, width: 500, height: 150 } };
    const caption: ReadingBlock = {
      ...figure,
      id: 'caption',
      kind: 'caption',
      text: 'caption text '.repeat(35),
      rect: { ...wide.rect, y: 225, height: 12 },
    };
    const layout = layoutDocument(
      document([wide, caption]),
      { ...config, pageWidthPt: 240, pageHeightPt: 456 },
      measure,
    );
    const placed = layout.pages[0].placements[0];
    expect(placed.type === 'region' && placed.rotation).toBeUndefined();
    expect(layout.pages).toHaveLength(1);
    expect(layout.pages[0].placements.some((item) => item.blockId === caption.id)).toBe(true);
  });

  it('still enlarges a page-filling figure whose caption was already on the next page', () => {
    const caption: ReadingBlock = {
      ...figure,
      id: 'caption',
      kind: 'caption',
      text: 'A detailed explanation of this large figure. '.repeat(20),
      rect: { ...figure.rect, y: 570, height: 12 },
    };
    const layout = layoutDocument(document([figure, caption]), config, measure);
    const placed = layout.pages[0].placements[0];
    expect(placed.type === 'region' && placed.rotation).toBe(90);
    expect([placed.width, placed.height]).toEqual([400, 120]);
    expect(
      layout.pages
        .flatMap((page) => page.placements)
        .filter((item) => item.blockId === caption.id)
        .map((item) => (item.type === 'text' ? item.text.replace(/\s/gu, '') : ''))
        .join(''),
    ).toBe(caption.text.replace(/\s/gu, ''));
  });

  it('opt-out preserves the original orientation and sizing', () => {
    const placement = layoutDocument(document(), { ...config, autoRotateFigures: false }, measure)
      .pages[0].placements[0];
    expect(placement.type === 'region' && placement.rotation).toBeUndefined();
    expect([placement.width, placement.height]).toEqual([60, 200]);
  });

  it('does not rotate on the nearly square default page', () => {
    const on = layoutDocument(document(), DEFAULT_CONFIG, measure);
    const off = layoutDocument(
      document(),
      { ...DEFAULT_CONFIG, autoRotateFigures: false },
      measure,
    );
    expect(on.pages).toEqual(off.pages);
    expect(on.warnings).toEqual(off.warnings);
  });
});
