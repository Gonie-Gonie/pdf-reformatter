import { describe, expect, it } from 'vitest';
import { analyzeDocument } from '../../src/core/analyze';
import type { SourceDocument, SourcePage, SourceText } from '../../src/core/model';

function text(id: string, value: string, x: number, y: number, width: number): SourceText {
  return {
    id,
    text: value,
    x,
    y,
    width,
    height: 13.04,
    fontSize: 8,
    baselineY: y + 9.5,
    fontName: 'serif',
    hasEOL: true,
  };
}

function analyze(items: SourceText[], graphicRegions: SourcePage['graphicRegions'] = []) {
  const page: SourcePage = {
    number: 1,
    width: 600,
    height: 800,
    rotation: 0,
    items,
    graphicRegions,
    warnings: [],
  };
  const source: SourceDocument = {
    schemaVersion: 1,
    hash: 'columns',
    name: 'columns.pdf',
    pageCount: 1,
    pages: [page],
    engine: 'test',
  };
  const reading = analyzeDocument(source);
  const owners = reading.blocks.flatMap((block) => block.sourceIds);
  expect(owners).toHaveLength(items.length);
  expect(new Set(owners).size).toBe(items.length);
  return reading.blocks;
}

describe('column analysis integration', () => {
  it.each(['center', 'right'] as const)(
    'joins original %s-aligned paragraph lines by their aligned edge',
    (alignment) => {
      const blocks = analyze(
        [200, 320, 440].map((width, index) => ({
          ...text(
            `aligned-${index}`,
            `A paragraph line ${index} with words in its original alignment`,
            alignment === 'center' ? 300 - width / 2 : 560 - width,
            80 + index * 20,
            width,
          ),
          alignment,
        })),
      );
      const body = blocks.find((block) => block.sourceIds.includes('aligned-0'))!;
      expect(body.sourceIds).toEqual(['aligned-0', 'aligned-1', 'aligned-2']);
      expect(body.alignment).toBe(alignment);
    },
  );

  it('keeps paragraphs with different explicit source alignments separate', () => {
    const blocks = analyze([
      {
        ...text('left', 'A left aligned paragraph continues across its original line', 36, 60, 520),
        alignment: 'left',
      },
      {
        ...text(
          'right',
          'A right aligned paragraph continues across its original line',
          36,
          80,
          520,
        ),
        alignment: 'right',
      },
    ]);
    expect(blocks.find((block) => block.sourceIds.includes('left'))?.alignment).toBe('left');
    expect(blocks.find((block) => block.sourceIds.includes('right'))?.alignment).toBe('right');
    expect(blocks.find((block) => block.sourceIds.includes('left'))?.sourceIds).toEqual(['left']);
    expect(blocks.find((block) => block.sourceIds.includes('right'))?.sourceIds).toEqual(['right']);
  });

  it('keeps dense prose in baseline order and confines superscripts to their own row', () => {
    const items = Array.from({ length: 8 }, (_, row) => [
      text(
        `left-${row}`,
        `Left paragraph row ${row} continues with ordinary words.`,
        36,
        70 + row * 10.49,
        250,
      ),
      text(
        `right-${row}`,
        `Right paragraph row ${row} continues with ordinary words.`,
        306,
        70 + row * 10.49,
        250,
      ),
    ]).flat();
    items.push({
      ...text('squared', '2', 285, 91, 3),
      fontSize: 6,
      height: 9.78,
      baselineY: 97,
    });
    const blocks = analyze(items);
    const left = blocks.filter((block) => block.sourceIds.some((id) => id.startsWith('left-')));
    const right = blocks.filter((block) => block.sourceIds.some((id) => id.startsWith('right-')));
    expect(Math.max(...left.map((block) => blocks.indexOf(block)))).toBeLessThan(
      Math.min(...right.map((block) => blocks.indexOf(block))),
    );
    const expression = blocks.find((block) => block.sourceIds.includes('squared'))!;
    expect(expression.kind).toBe('paragraph');
    expect(expression.inlineMath?.some((atom) => atom.sourceIds.includes('squared'))).toBe(true);
    expect(
      blocks.flatMap((block) => block.inlineMath ?? []).every((atom) => atom.rect.height < 40),
    ).toBe(true);
    expect(left[0].text).toMatch(/^Left paragraph row 0/);
    expect(right[0].text).toMatch(/^Right paragraph row 0/);
  });

  it('uses different gutters on either side of an isolated page-wide separator', () => {
    const items = Array.from({ length: 4 }, (_, row) => [
      text(`metadata-${row}`, 'Metadata words in a sidebar', 36, 60 + row * 14, 110),
      text(`summary-${row}`, 'Summary words in a wider text column', 202, 60 + row * 14, 354),
      text(`body-left-${row}`, 'First body column continues normally', 36, 160 + row * 14, 250),
      text(`body-right-${row}`, 'Second body column continues normally', 306, 160 + row * 14, 250),
    ]).flat();
    const blocks = analyze(items, [{ x: 35, y: 130, width: 530, height: 3 }]);
    const order = blocks.flatMap((block) => block.sourceIds);
    expect(order.indexOf('metadata-3')).toBeLessThan(order.indexOf('summary-0'));
    expect(order.indexOf('summary-3')).toBeLessThan(order.indexOf('body-left-0'));
    expect(order.indexOf('body-left-3')).toBeLessThan(order.indexOf('body-right-0'));
  });

  it('retains zero-advance equation marks in a finite source region', () => {
    const items = [
      text('prose', 'Ordinary prose before a displayed equation.', 36, 60, 250),
      text('equation', 'max x − max y = 0', 36, 100, 100),
      { ...text('bar', '\u20d2\u20d2', 137, 94, 0), height: 8, baselineY: 101 },
      text('after', 'Ordinary prose after the equation.', 36, 140, 250),
    ];
    const blocks = analyze(items);
    const preserved = blocks.find((block) => block.sourceIds.includes('bar'));
    expect(preserved?.kind).toBe('sourceRegion');
    expect(preserved?.rect.width).toBeGreaterThan(0);
    expect(blocks.find((block) => block.sourceIds.includes('prose'))?.kind).toBe('paragraph');
    expect(blocks.find((block) => block.sourceIds.includes('after'))?.kind).toBe('paragraph');
  });
});
