import { describe, expect, it } from 'vitest';
import { analyzeDocument } from '../../src/core/analyze';
import { DEFAULT_CONFIG } from '../../src/core/config';
import { flowingText } from '../../src/core/inline-content';
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
  it('keeps a compact illustration below body text and above a running footer', () => {
    const illustration = { x: 200, y: 670, width: 120, height: 40 };
    const pages = [1, 2, 3].map((number) => ({
      ...page(number, [
        text(
          `body-${number}`,
          'The paragraph ends above an uncaptioned illustration.',
          50,
          600,
          500,
        ),
        text(`footer-${number}`, 'Journal of Research', 50, 770, 100, 8),
      ]),
      graphicRegions: [illustration, { x: 40, y: 758, width: 520, height: 8 }],
    }));
    const reading = analyzeDocument(source(pages));
    for (const number of [1, 2, 3]) {
      const regions = reading.blocks.filter(
        (block) => block.sourcePage === number && block.kind === 'sourceRegion' && !block.running,
      );
      expect(regions).toHaveLength(1);
      const crop = regions[0].rect;
      expect(crop.x).toBeLessThanOrEqual(illustration.x);
      expect(crop.y).toBeLessThanOrEqual(illustration.y);
      expect(crop.x + crop.width).toBeGreaterThanOrEqual(illustration.x + illustration.width);
      expect(crop.y + crop.height).toBeGreaterThanOrEqual(illustration.y + illustration.height);
      expect(crop.y + crop.height).toBeLessThan(730);
      expect(
        reading.blocks.find((block) => block.sourceIds.includes(`footer-${number}`))?.running,
      ).toBe('footer');
    }
  });

  it('routes a vertical publisher stamp and its detected ink to page furniture', () => {
    const pages = [1, 2, 3].map((number) => ({
      ...page(number, [
        text(
          `body-${number}`,
          'Ordinary article text must not share a page-sized stamp crop.',
          50,
          100,
          490,
        ),
        {
          ...text(
            `stamp-${number}`,
            'Downloaded from the publisher library under its open access licence.',
            584,
            17,
            5,
            5,
          ),
          height: 766,
          preserve: true,
          rotation: 90,
        },
      ]),
      graphicRegions: [{ x: 580, y: 13, width: 13, height: 775 }],
    }));
    const reading = analyzeDocument(source(pages));
    for (const number of [1, 2, 3]) {
      expect(
        reading.blocks.find((block) => block.sourceIds.includes(`stamp-${number}`))?.running,
      ).toBe('footer');
      expect(
        reading.blocks
          .filter((block) => block.sourcePage === number && !block.running)
          .every((block) => block.kind !== 'sourceRegion'),
      ).toBe(true);
    }
  });

  it('keeps hanging list continuations together without absorbing a following paragraph', () => {
    const reading = analyzeDocument(
      source([
        page(1, [
          text('bullet', '• Participation type. Studies of partici-', 40, 120, 250),
          text('continuation', 'pation continue on the next original line.', 47, 132, 243),
          text('next-bullet', '• Assessment method. Another item continues on', 40, 156, 250),
          text(
            'next-continuation',
            'Its indented continuation remains with that item.',
            47,
            168,
            243,
          ),
          text('body', 'A separate body paragraph starts at the normal column edge.', 40, 200, 250),
        ]),
      ]),
    );
    expect(reading.blocks.find((block) => block.sourceIds.includes('bullet'))?.sourceIds).toEqual([
      'bullet',
      'continuation',
    ]);
    expect(
      reading.blocks.find((block) => block.sourceIds.includes('next-bullet'))?.sourceIds,
    ).toEqual(['next-bullet', 'next-continuation']);
    expect(reading.blocks.find((block) => block.sourceIds.includes('body'))?.kind).toBe(
      'paragraph',
    );
  });

  it('keeps a repeated shallow publisher banner in the running header', () => {
    const pages = [1, 2, 3].map((number) => ({
      ...page(number, [
        text(`header-${number}`, 'www.publisher.org/journal/', 40, 14, 170),
        text(
          `body-${number}`,
          'The article body begins below the running publisher banner.',
          150,
          70,
          390,
        ),
      ]),
      graphicRegions: [{ x: 0, y: 0, width: 600, height: 32 }],
    }));
    const reading = analyzeDocument(source(pages));
    for (const number of [1, 2, 3]) {
      const header = reading.blocks.find((block) => block.sourceIds.includes(`header-${number}`))!;
      expect(header.running).toBe('header');
      expect(header.kind).toBe('sourceRegion');
      expect(header.rect).toEqual({ x: 0, y: 0, width: 600, height: 32 });
      expect(reading.blocks.find((block) => block.sourceIds.includes(`body-${number}`))?.kind).toBe(
        'paragraph',
      );
      expect(
        reading.blocks.filter(
          (block) => block.sourcePage === number && block.kind === 'sourceRegion',
        ),
      ).toHaveLength(1);
    }
  });

  it('preserves a clipped marginal artifact without rasterizing the ordinary body', () => {
    const original = page(1, [
      text(
        'body',
        'The ordinary body remains reflowable beside a marginal artifact.',
        180,
        100,
        370,
      ),
      { ...text('artifact', 'x FOR PEER REVIEW', -4, 190, 85), artifact: true },
    ]);
    const reading = analyzeDocument(source([original]));
    expect(reading.blocks.find((block) => block.sourceIds.includes('body'))?.kind).toBe(
      'paragraph',
    );
    const preserved = reading.blocks.find((block) => block.sourceIds.includes('artifact'))!;
    expect(preserved.kind).toBe('sourceRegion');
    expect(preserved.rect.x).toBe(0);
    expect(preserved.rect.width).toBeLessThan(100);
    expect(reading.blocks.flatMap((block) => block.sourceIds).sort()).toEqual(['artifact', 'body']);
  });

  it('keeps scientific notation local while the surrounding paragraph reflows', () => {
    const run = (
      id: string,
      value: string,
      x: number,
      width: number,
      size = 10,
      baseline = 110,
    ): SourceText => ({
      ...text(id, value, x, baseline - size * 1.2, width, size),
      height: size * 1.6,
      baselineY: baseline,
      hasEOL: false,
    });
    const original = page(1, [
      run('before', 'Ordinary prose reports the significance test (permutation', 50, 250),
      { ...run('variable', 'p', 303, 5), fontName: 'italic' },
      { ...run('comparison', '<', 311, 8), fontName: 'comparison' },
      run('coefficient', '5', 322, 5),
      { ...run('multiply', '\u22c5', 327, 3), fontName: 'symbol' },
      run('ten', '10', 330, 10),
      { ...run('minus', '\u0000', 340, 2, 7.5, 105.5), fontName: 'superscript' },
      run('power', '5', 346, 4, 7.5, 105.5),
      run('after', '), and additional observations remain ordinary prose.', 350, 200),
    ]);
    const reading = analyzeDocument(source([original]));
    const body = reading.blocks.find((block) => block.sourceIds.includes('before'))!;
    expect(body.kind).toBe('paragraph');
    expect(body.sourceIds).toContain('after');
    expect(reading.blocks.flatMap((block) => block.sourceIds).sort()).toEqual(
      original.items.map((item) => item.id).sort(),
    );
    const expression = body.inlineMath!.find((atom) => atom.sourceIds.includes('minus'))!;
    expect(expression.sourceIds).toEqual([
      'variable',
      'comparison',
      'coefficient',
      'multiply',
      'ten',
      'minus',
      'power',
      'after',
    ]);
    expect(body.text.slice(expression.start, expression.end)).toContain('5\u22c510');
    expect(flowingText(body)).not.toMatch(/[\u0000\u22c5]/u);
    expect(flowingText(body)).toContain('additional observations');

    const layout = layoutDocument(reading, DEFAULT_CONFIG, measure);
    const placements = layout.pages
      .flatMap((entry) => entry.placements)
      .filter((placement) => placement.blockId === body.id);
    const prose = placements
      .filter((placement) => placement.type === 'text')
      .map((placement) => placement.text)
      .join(' ');
    expect(prose).toContain('Ordinary prose');
    expect(prose).toContain('remain ordinary prose.');
    const regions = placements.filter((placement) => placement.type === 'region');
    expect(regions).toHaveLength(1);
    expect(regions[0].sourceRect.width).toBeLessThan(60);
    expect(regions[0].sourceRect.height).toBeLessThan(20);
  });

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
