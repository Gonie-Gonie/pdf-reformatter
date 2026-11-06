import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/core/config';
import { inlineContent, inlineFragments } from '../../src/core/inline-content';
import { findLayoutAnchor, layoutDocument } from '../../src/core/layout';
import type {
  InlineMathSpan,
  LayoutConfig,
  Placement,
  ReadingBlock,
  ReadingDocument,
  RegionPlacement,
  TextPlacement,
} from '../../src/core/model';

const measure = (text: string, size: number) => [...text].length * size * 0.5;
const normalized = (text: string) => text.normalize('NFKC').replace(/[\s\u00ad]/gu, '');
const config: LayoutConfig = {
  ...DEFAULT_CONFIG,
  pageWidthPt: 240,
  pageHeightPt: 240,
  marginTopPt: 12,
  marginBottomPt: 12,
  marginLeftPt: 12,
  marginRightPt: 12,
  fontSizePt: 12,
  lineHeightPt: 20,
};

function paragraph(
  value: string,
  expression = 'R²',
  dimensions: Partial<InlineMathSpan> = {},
): ReadingBlock {
  const start = value.indexOf(expression);
  if (start < 0) throw new Error('The inline expression must occur in the fixture.');
  return {
    id: 'body',
    kind: 'paragraph',
    sourcePage: 1,
    sourceIds: ['mixed-source-run'],
    rect: { x: 40, y: 100, width: 320, height: 24 },
    text: value,
    rawText: value,
    fontSize: 8,
    confidence: 'high',
    sourceSpans: [
      {
        sourceId: 'mixed-source-run',
        start: 0,
        end: normalized(value).length,
        rect: { x: 40, y: 100, width: 320, height: 24 },
      },
    ],
    inlineMath: [
      {
        start,
        end: start + expression.length,
        sourceIds: ['mixed-source-run'],
        rect: { x: 80, y: 100, width: 8, height: 12 },
        baselineY: 108,
        fontSize: 8,
        ...dimensions,
      },
    ],
  };
}

function document(blocks: ReadingBlock[]): ReadingDocument {
  return { schemaVersion: 1, sourceHash: 'inline-layout', blocks, warnings: [] };
}

function placements(layout: ReturnType<typeof layoutDocument>): Placement[] {
  return layout.pages
    .flatMap((page) => page.placements)
    .filter((placement) => !placement.decoration);
}
function mathRegion(layout: ReturnType<typeof layoutDocument>): RegionPlacement {
  return placements(layout).find(
    (placement): placement is RegionPlacement =>
      placement.type === 'region' && placement.math === true,
  )!;
}

describe('inline mathematical objects in flowing paragraphs', () => {
  it('retains the unchanged source text while using internal markers only for layout', () => {
    const block = paragraph('A ﬁtted model with R² retains its original spelling and symbols.');
    const original = JSON.stringify(block);
    const content = inlineContent(block);
    const restored = inlineFragments(content.text, content.atoms)
      .map((part) => part.text)
      .join('');
    expect(restored).toBe(block.text);
    const layout = layoutDocument(document([block]), config, measure);
    expect(JSON.stringify(block)).toBe(original);
    const ordered = placements(layout)
      .map((placement) =>
        placement.type === 'text'
          ? normalized(placement.text)
          : normalized(block.text).slice(placement.textStart, placement.textEnd),
      )
      .join('');
    expect(ordered).toBe(normalized(block.text));
    expect(
      placements(layout).some(
        (placement) => placement.type === 'text' && /\p{Co}/u.test(placement.text),
      ),
    ).toBe(false);
  });

  it('keeps prose at the configured size and justifies the line around a mid-sentence R² object', () => {
    const block = paragraph(
      'A model with R² keeps readable prose and consistent word spacing across many ordinary words in this complete paragraph.',
    );
    const layout = layoutDocument(document([block]), config, measure);
    const atom = mathRegion(layout);
    expect(placements(layout).filter((placement) => placement.type === 'region')).toHaveLength(1);
    expect(atom.sourceRect).toEqual(block.inlineMath![0].rect);
    const text = placements(layout).filter(
      (placement): placement is TextPlacement => placement.type === 'text',
    );
    expect(text.every((placement) => placement.fontSize === config.fontSizePt)).toBe(true);
    const source = block.inlineMath![0];
    const mathBaseline =
      atom.y + ((source.baselineY - source.rect.y) * atom.height) / source.rect.height;
    const sameRow = text.filter(
      (placement) => Math.abs(placement.y + placement.fontSize - mathBaseline) < 0.01,
    );
    expect(sameRow.length).toBeGreaterThan(1);
    expect(Math.min(...sameRow.map((placement) => placement.x), atom.x)).toBe(config.marginLeftPt);
    expect(
      Math.max(...sameRow.map((placement) => placement.x + placement.width), atom.x + atom.width),
    ).toBeCloseTo(config.pageWidthPt - config.marginRightPt);
    expect(text.some((placement) => placement.y > sameRow[0].y)).toBe(true);
  });

  it('routes before, inside, and after anchors from one partially mathematical source run', () => {
    const block = paragraph(
      'A ﬁtted model with R² keeps later prose flowing through additional lines without losing its source anchors.',
    );
    const reading = document([block]);
    const layout = layoutDocument(reading, config, measure);
    const atom = mathRegion(layout);
    const start = normalized(block.text.slice(0, block.inlineMath![0].start)).length;
    const end = normalized(block.text.slice(0, block.inlineMath![0].end)).length;
    expect(atom.textStart).toBe(start);
    expect(atom.textEnd).toBe(end);
    const locate = (offset: number) =>
      findLayoutAnchor(
        layout,
        reading,
        { blockId: block.id, sourceId: 'mixed-source-run', offset },
        measure,
      )!;
    const before = locate(0);
    const inside = locate(start + 1);
    const after = locate(end);
    const last = locate(normalized(block.text).length - 1);
    expect(before.rect.x).toBe(config.marginLeftPt);
    expect(inside.rect).toEqual({ x: atom.x, y: atom.y, width: atom.width, height: atom.height });
    expect(after.rect.x).toBeGreaterThanOrEqual(atom.x + atom.width);
    expect(last.rect.y).toBeGreaterThan(after.rect.y);
    expect(last.rect.width).toBe(measure('.', config.fontSizePt));
  });

  it('reserves a taller fraction row and keeps adjacent rows and pages free of overlap', () => {
    const block = paragraph(
      'The R² expression has a tall numerator and denominator while all following prose must remain comfortably below it on subsequent lines.',
      'R²',
      {
        rect: { x: 80, y: 94, width: 16, height: 28 },
        baselineY: 110,
      },
    );
    const layout = layoutDocument(document([block]), { ...config, pageHeightPt: 120 }, measure);
    const atom = mathRegion(layout);
    expect(atom.height).toBeCloseTo(42);
    const source = block.inlineMath![0];
    const baseline =
      atom.y + ((source.baselineY - source.rect.y) * atom.height) / source.rect.height;
    const onFirstPage = layout.pages[0].placements.filter((placement) => !placement.decoration);
    const text = onFirstPage.filter(
      (placement): placement is TextPlacement => placement.type === 'text',
    );
    const mathRow = text.filter(
      (placement) => Math.abs(placement.y + placement.fontSize - baseline) < 0.01,
    );
    expect(mathRow.length).toBeGreaterThan(0);
    const rowBottom = Math.max(
      atom.y + atom.height,
      ...mathRow.map((placement) => placement.y + placement.height),
    );
    for (const placement of text.filter(
      (placement) => placement.y + placement.fontSize > baseline + 0.01,
    ))
      expect(placement.y).toBeGreaterThanOrEqual(rowBottom);
    for (const page of layout.pages)
      for (const placement of page.placements) {
        expect(placement.y).toBeGreaterThanOrEqual(config.marginTopPt);
        expect(placement.y + placement.height).toBeLessThanOrEqual(
          120 - config.marginBottomPt - 16 + 0.01,
        );
      }
  });

  it('fits an over-wide atom intact on its own line and paginates surrounding prose', () => {
    const block = paragraph(
      `${'Earlier prose continues before the expression. '.repeat(10)}R² ${'Following prose continues after the expression. '.repeat(10)}`,
      'R²',
      {
        rect: { x: 80, y: 100, width: 480, height: 24 },
        baselineY: 116,
      },
    );
    const reading = document([block]);
    const layout = layoutDocument(reading, { ...config, pageHeightPt: 120 }, measure);
    const atom = mathRegion(layout);
    expect(layout.pages.length).toBeGreaterThan(2);
    expect(layout.pages.every((page) => page.placements.length > 0)).toBe(true);
    expect(placements(layout).filter((placement) => placement.type === 'region')).toHaveLength(1);
    expect(atom.width).toBeCloseTo(config.pageWidthPt - config.marginLeftPt - config.marginRightPt);
    expect(atom.x).toBe(config.marginLeftPt);
    const atomPage = layout.pages.find((page) => page.placements.includes(atom))!;
    const sameBand = atomPage.placements.filter(
      (placement) =>
        placement !== atom &&
        placement.y < atom.y + atom.height &&
        placement.y + placement.height > atom.y,
    );
    expect(sameBand).toHaveLength(0);
    expect(
      findLayoutAnchor(
        layout,
        reading,
        {
          blockId: block.id,
          sourceId: 'mixed-source-run',
          offset: normalized(block.text).length - 1,
        },
        measure,
      )!.page,
    ).toBe(layout.pages.at(-1)!.number);
  });
});
