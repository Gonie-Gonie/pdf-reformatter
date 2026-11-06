import { describe, expect, it } from 'vitest';
import { analyzeDocument } from '../../src/core/analyze';
import { DEFAULT_CONFIG } from '../../src/core/config';
import { layoutDocument } from '../../src/core/layout';
import type { SourceDocument, SourcePage, SourceText } from '../../src/core/model';

function text(
  id: string,
  value: string,
  x: number,
  y: number,
  width: number,
  size = 10,
): SourceText {
  return {
    id,
    text: value,
    x,
    y,
    width,
    height: size,
    fontSize: size,
    fontName: 'serif',
    hasEOL: true,
  };
}
function page(number: number, items: SourceText[]): SourcePage {
  return { number, items, width: 600, height: 800, rotation: 0, graphicRegions: [], warnings: [] };
}
function source(pages: SourcePage[]): SourceDocument {
  return {
    schemaVersion: 1,
    hash: 'continuity',
    name: 'article.pdf',
    engine: 'synthetic',
    pageCount: pages.length,
    pages,
  };
}
const measure = (value: string, size: number) => (value.length * size) / 2;

describe('reflow continuity', () => {
  it('keeps a row together when a small overlapping math run precedes later prose', () => {
    const result = analyzeDocument(
      source([
        page(1, [
          text('first', 'Ordinary prose before the expression', 40, 100, 160),
          text('symbol', '\u0000', 100, 100, 2),
          text('last', 'with additional ordinary words.', 201, 100, 140),
        ]),
      ]),
    );
    const body = result.blocks.find((block) => block.sourceIds.includes('first'))!;
    expect(body.kind).toBe('paragraph');
    expect(body.sourceIds).toEqual(['first', 'symbol', 'last']);
    expect(body.inlineMath?.some((atom) => atom.sourceIds.includes('symbol'))).toBe(true);
  });

  it('does not turn a decimal coefficient and inline formula into a section heading', () => {
    const result = analyzeDocument(
      source([
        page(1, [
          text('coefficient', '0.5', 40, 100, 18),
          { ...text('formula', 'max', 60, 100, 16), fontName: 'math' },
          text('continuation', 'computed from ordinary samples', 90, 100, 220),
        ]),
      ]),
    );
    const body = result.blocks.find((block) => block.sourceIds.includes('coefficient'))!;
    expect(body.kind).toBe('paragraph');
    expect(body.inlineMath?.length).toBeGreaterThan(0);
  });

  it('keeps a raised radical with its prose rows and crops before the next row', () => {
    const first = {
      ...text(
        'first',
        'Several ordinary prose words precede this inline expression',
        108,
        100,
        396,
      ),
      baselineY: 106.75,
    };
    const radical = { ...text('radical', '\u221a', 250, 102.61, 8.3), baselineY: 109.916 };
    const second = {
      ...text(
        'second',
        'Additional ordinary prose words continue on the following row',
        108,
        110.909,
        396,
      ),
      baselineY: 117.659,
    };
    const last = { ...text('last', 'values.', 108, 121.978, 28), baselineY: 128.728 };
    const original = page(1, [first, radical, second, last]);
    original.graphicRegions = [{ x: 249, y: 112.67, width: 9, height: 9 }];
    const result = analyzeDocument(source([original]));
    const group = result.blocks.find((block) => block.sourceIds.includes('radical'))!;
    expect(group.kind).toBe('paragraph');
    expect(group.sourceIds).toContain('first');
    expect(group.sourceIds).toContain('second');
    const atom = group.inlineMath!.find((item) => item.sourceIds.includes('radical'))!;
    expect(atom.rect.width).toBeLessThan(20);
    expect(atom.rect.y + atom.rect.height).toBeLessThan(last.y + 1);
    expect(atom.rect.y + atom.rect.height).toBeGreaterThanOrEqual(121.67);
    expect(result.blocks.flatMap((block) => block.sourceIds).sort()).toEqual([
      'first',
      'last',
      'radical',
      'second',
    ]);
  });
  it('keeps an extracted space when italic glyph boxes overlap', () => {
    const left = text('left', 'HVAC', 50, 100, 24.5);
    const right = { ...text('right', 'propagation', 73, 100, 55), spaceBefore: true };
    const result = analyzeDocument(source([page(1, [left, right])]));
    expect(result.blocks.map((block) => block.text).join(' ')).toBe('HVAC propagation');
  });

  it('does not insert a word space after a source line ending in a hyphen', () => {
    const result = analyzeDocument(
      source([
        page(1, [
          text('first', 'Typical one-zone-', 50, 100, 490),
          text('second', 'per-floor representation continues.', 50, 114, 490),
        ]),
      ]),
    );
    expect(result.blocks[0].text).toBe('Typical one-zone-per-floor representation continues.');
  });

  it('keeps a small publisher logo in the running header and outside the body', () => {
    const original = page(3, [
      { ...text('folio', '2', 59, 27.5, 4, 7.5), artifact: true },
      { ...text('head', 'AUTHOR ET AL.', 89, 27.5, 50, 7.5), artifact: true },
      ...Array.from({ length: 6 }, (_, index) =>
        text(
          `body-${index}`,
          'Ordinary prose continues with normal body text.',
          59,
          80 + index * 14,
          240,
        ),
      ),
    ]);
    original.graphicRegions = [{ x: 69, y: 23, width: 15, height: 15 }];
    const reading = analyzeDocument(source([original]));
    const logo = reading.blocks.find((block) => block.running && block.kind === 'sourceRegion');
    expect(logo?.rect).toEqual(original.graphicRegions[0]);
    expect(
      reading.blocks.filter((block) => !block.running).some((block) => block.rect.y < 60),
    ).toBe(false);
    const layout = layoutDocument(reading, DEFAULT_CONFIG, measure);
    const placements = layout.pages.flatMap((entry) => entry.placements);
    expect(
      placements
        .filter((placement) => placement.blockId === logo?.id)
        .every((placement) => placement.decoration === 'runningHeader'),
    ).toBe(true);
    expect(
      placements.some((placement) => placement.type === 'text' && placement.text === '2'),
    ).toBe(false);
    const header = placements.filter((placement) => placement.decoration === 'runningHeader');
    expect(header[0].type).toBe('region');
    expect(reading.blocks.flatMap((block) => block.sourceIds).sort()).toEqual(
      original.items.map((item) => item.id).sort(),
    );
  });

  it('estimates prose size after removing small diagram labels', () => {
    const original = page(1, [
      ...Array.from({ length: 24 }, (_, index) =>
        text(
          `label-${index}`,
          'small diagram label',
          70 + (index % 3) * 100,
          100 + Math.floor(index / 3) * 12,
          90,
          6,
        ),
      ),
      ...Array.from({ length: 3 }, (_, index) =>
        text(
          `body-${index}`,
          'Body prose continues naturally across consecutive source lines.',
          50,
          300 + index * 14,
          490,
        ),
      ),
    ]);
    original.graphicRegions = [{ x: 60, y: 90, width: 450, height: 120 }];
    const reading = analyzeDocument(source([original]));
    const body = reading.blocks.find((block) => block.sourceIds.includes('body-0'))!;
    expect(body.kind).toBe('paragraph');
    expect(body.sourceIds).toEqual(['body-0', 'body-1', 'body-2']);
  });

  it('starts an article masthead on a fresh output page after a short cover', () => {
    const original = page(2, [
      text('journal', 'Journal of an academic discipline', 60, 54, 200, 7.5),
      text('doi', 'https://doi.org/10.example/article', 60, 65, 170, 7.5),
      {
        ...text('title', 'A general article title with enough words', 60, 104, 440, 14),
        structureRoles: ['H1'],
      },
      ...Array.from({ length: 8 }, (_, index) =>
        text(
          `body-${index}`,
          'Ordinary body prose fills an article column.',
          60,
          200 + index * 14,
          240,
        ),
      ),
    ]);
    original.graphicRegions = [{ x: 59, y: 10, width: 493, height: 82 }];
    const reading = analyzeDocument(
      source([page(1, [text('cover', 'Short cover', 60, 150, 100)]), original]),
    );
    expect(reading.blocks.find((block) => block.sourcePage === 2)?.startOnNewPage).toBe(true);
    const layout = layoutDocument(reading, DEFAULT_CONFIG, measure);
    expect(layout.pages[0].sourcePages).toEqual([1]);
    expect(layout.pages[1].sourcePages).toEqual([2]);
  });
});
