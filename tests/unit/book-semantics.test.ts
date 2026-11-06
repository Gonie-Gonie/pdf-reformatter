import { describe, expect, it } from 'vitest';
import { analyzePageSemantics } from '../../src/core/semantics';
import { analyzeDocument } from '../../src/core/analyze';
import type { SourcePage, SourceText } from '../../src/core/model';

function text(id: string, value: string, x: number, y: number, width = 100, size = 10): SourceText {
  return {
    id,
    text: value,
    x,
    y,
    width,
    height: size,
    fontSize: size,
    fontName: 'Times',
    hasEOL: true,
  };
}
function page(items: SourceText[], rules: SourcePage['graphicRegions'] = []): SourcePage {
  return {
    number: 1,
    width: 600,
    height: 800,
    rotation: 0,
    items,
    graphicRegions: rules,
    warnings: [],
  };
}
const rule = (y: number, x = 60, width = 480, height = 3) => ({ x, y, width, height });

describe('book table and reference layouts', () => {
  it('preserves a captioned three-column table with wrapped cells and only separated edge fragments', () => {
    const cells = [
      text('head-a', 'Model', 60, 104, 30, 8),
      text('head-b', 'Configuration', 105, 104, 90, 8),
      text('head-c', 'Loss / training', 270, 104, 70, 8),
      ...Array.from({ length: 6 }, (_, row) => [
        text(`name-${row}`, `M${row}`, 60, 124 + row * 36, 25, 8),
        text(`config-${row}`, 'A configuration with wrapping', 105, 124 + row * 36, 150, 8),
        text(`wrap-${row}`, 'preserves its cell association', 105, 136 + row * 36, 150, 8),
        text(`wrap-tail-${row}`, 'and the final training settings', 105, 148 + row * 36, 150, 8),
        text(`loss-${row}`, 'Squared error', 270, 124 + row * 36, 70, 8),
      ]).flat(),
    ];
    const source = page(
      [
        text('caption', 'Table 2', 54, 70, 45, 10),
        text('description', 'Model descriptions and training settings.', 54, 84, 280, 10),
        ...cells,
        text('after', 'The following subsection stays ordinary prose.', 54, 365, 470, 10),
      ],
      [
        rule(100, 180, 80, 14),
        rule(100, 320, 35, 14),
        rule(115, 88, 12, 4),
        rule(340, 54, 42),
        rule(340, 260, 90),
      ],
    );
    const table = analyzePageSemantics(source).blocks.find((b) => b.semantic === 'table');
    expect(table?.sourceIds.sort()).toEqual(cells.map((entry) => entry.id).sort());
    expect(table?.rect.y).toBeLessThanOrEqual(100);
    expect(table!.rect.y + table!.rect.height).toBeGreaterThanOrEqual(343);
    source.items.push(
      text('crossing-prose', 'A prose line crossing the proposed cells.', 120, 282, 180, 8),
    );
    expect(analyzePageSemantics(source).blocks.some((b) => b.semantic === 'table')).toBe(false);
  });

  it('keeps a decimal-captioned single-column taxonomy together without claiming surrounding prose', () => {
    const cells = [
      'Description',
      'Climate',
      'Air movement',
      'Thermal radiation',
      'Humidity',
      'Occupancy',
    ].map((value, i) => text(`cell-${i}`, value, 100, 110 + i * 18, 180));
    const source = page(
      [
        text('before', 'The categories are described below.', 60, 50, 400),
        text('caption', 'Table 2.1', 100, 80),
        ...cells,
        text('after', 'The next paragraph explains the model.', 60, 240, 400),
      ],
      [rule(100, 98, 210), rule(210, 98, 210)],
    );
    const tables = analyzePageSemantics(source).blocks.filter((b) => b.semantic === 'table');
    expect(tables).toHaveLength(1);
    expect(tables[0].sourceIds.sort()).toEqual(cells.map((i) => i.id).sort());
  });

  it('includes stacked headings and disconnected rule fragments in one table crop', () => {
    const cells = Array.from({ length: 7 }, (_, row) => [
      text(`a-${row}`, row ? `Category ${row}` : 'Environment', 62, 140 + row * 18, 170),
      text(`b-${row}`, row ? `${row * 10}` : 'Temperature', 330, 140 + row * 18, 120),
    ]).flat();
    const source = page(
      [
        text('caption', 'Table 1.2', 62, 90),
        text('header-top', 'Required', 330, 112, 100),
        ...cells,
        text('after', 'The following discussion remains ordinary text.', 60, 305, 470),
      ],
      [rule(108, 325, 140, 46), rule(150, 60, 185, 4), rule(274, 60, 405)],
    );
    const table = analyzePageSemantics(source).blocks.find((b) => b.semantic === 'table');
    expect(table?.sourceIds).toEqual(
      expect.arrayContaining(['header-top', ...cells.map((i) => i.id)]),
    );
    expect(table?.sourceIds).not.toContain('after');
    expect(table?.rect.y).toBe(108);
  });

  it('keeps the aligned continuation rows below surviving header rules', () => {
    const cells = Array.from({ length: 10 }, (_, row) => [
      text(`l-${row}`, `Performance ${row}`, 62, 120 + row * 16, 150),
      text(`r-${row}`, `An explanatory definition ${row}`, 300, 120 + row * 16, 225),
    ]).flat();
    const source = page(
      [
        text('caption', 'Table 6.1', 62, 78),
        text('span', 'Building performance', 220, 98, 150),
        ...cells,
        text('after', 'Ordinary prose continues below the table.', 60, 315, 475),
      ],
      [rule(92), rule(115)],
    );
    const table = analyzePageSemantics(source).blocks.find((b) => b.semantic === 'table');
    expect(table?.sourceIds).toEqual(expect.arrayContaining(['span', ...cells.map((i) => i.id)]));
    expect(table?.sourceIds).not.toContain('after');
    expect(table!.rect.y + table!.rect.height).toBeGreaterThan(270);
  });

  it('recognizes an uncaptioned ruled appendix matrix while rejecting two-column prose', () => {
    const cells = Array.from({ length: 10 }, (_, row) => [
      text(`a-${row}`, `Aspect ${row}`, 62, 130 + row * 16, 130),
      text(`b-${row}`, 'provide', 250, 130 + row * 16, 60),
      text(`c-${row}`, 'quality', 420, 130 + row * 16, 60),
    ]).flat();
    const headers = [
      text('h-a', 'Aspect', 62, 100),
      text('h-b', 'Function', 250, 100),
      text('h-c', 'Requirement', 420, 100),
    ];
    const source = page(
      [
        ...headers,
        ...cells,
        text('wrapped-cell', 'cell continuation', 250, 283, 90),
        text('last-left', 'Final aspect', 62, 297, 100),
        text('last-middle', 'provide', 250, 297, 60),
        text('last-right', 'quality', 420, 297, 60),
        text('after', 'An ordinary paragraph follows.', 60, 330, 450),
      ],
      [{ ...rule(70), height: 23 }, rule(120)],
    );
    const table = analyzePageSemantics(source).blocks.find((b) => b.semantic === 'table');
    expect(table?.sourceIds).toHaveLength(37);
    expect(table?.sourceIds).not.toContain('after');
    source.items = source.items.filter((i) => !i.id.startsWith('c-') && i.id !== 'h-c');
    expect(analyzePageSemantics(source).blocks.some((b) => b.semantic === 'table')).toBe(false);
  });

  it('pairs index entries and wrapped numeric references within their own columns', () => {
    const entries = Array.from({ length: 8 }, (_, row) => [
      text(`l-${row}`, `Analytical function ${row + 10}`, 60, 130 + row * 20, 150, 9),
      text(`r-${row}`, `Behavioural subsets ${row + 200}`, 330, 130 + row * 20, 160, 9),
    ]).flat();
    const source = page([
      text('heading', 'Index', 60, 70),
      ...entries,
      text('wrapped-title', 'Wrapped entry', 60, 305, 90, 9),
      text('wrapped-pages', '123, 126–128', 70, 316, 80, 9),
    ]);
    const blocks = analyzePageSemantics(source).blocks.filter((b) => b.semantic === 'index');
    expect(blocks.some((b) => b.sourceIds.includes('l-0') && b.sourceIds.includes('r-0'))).toBe(
      false,
    );
    expect(blocks.find((b) => b.sourceIds.includes('wrapped-pages'))?.sourceIds).toContain(
      'wrapped-title',
    );
    expect(new Set(blocks.flatMap((b) => b.sourceIds)).size).toBe(entries.length + 2);
  });

  it('recognizes contents with inline folios and overlapping font boxes without joining adjacent entries', () => {
    const source = page([
      text('heading', 'Contents', 60, 70),
      ...Array.from({ length: 6 }, (_, row) => [
        { ...text(`title-${row}`, `Chapter ${row}`, 60, 120 + row * 12, 100), height: 15 },
        { ...text(`folio-${row}`, `${row + 1}`, 170, 120 + row * 12, 8), height: 15 },
      ]).flat(),
    ]);
    const blocks = analyzePageSemantics(source).blocks.filter((b) => b.semantic === 'toc');
    expect(blocks).toHaveLength(6);
    blocks.forEach((block, i) => expect(block.sourceIds).toEqual([`title-${i}`, `folio-${i}`]));
    blocks.slice(0, -1).forEach((block, i) => {
      expect(block.rect.y + block.rect.height).toBe(132 + i * 12);
      expect(block.rect.y + block.rect.height).toBeGreaterThanOrEqual(120 + i * 12 + 10 * 1.2);
    });
  });

  it('does not claim dense numeric plot ticks as untagged footnotes', () => {
    const source = page([
      text('body', 'The chart describes the results.', 60, 100, 400),
      ...Array.from({ length: 8 }, (_, i) =>
        text(`tick-${i}`, `${i * 10}`, 60 + i * 50, 700, 15, 7),
      ),
    ]);
    expect(analyzePageSemantics(source).blocks.filter((b) => b.semantic === 'note')).toEqual([]);
  });

  it('reads a three-column index down each column before advancing to the next', () => {
    const entries = [60, 245, 425].flatMap((x, column) =>
      Array.from({ length: 8 }, (_, row) =>
        text(
          `c${column}-r${row}`,
          `Building systems ${column * 100 + row + 1}`,
          x,
          120 + row * 18,
          115,
          9,
        ),
      ),
    );
    const source = page([text('heading', 'Index', 60, 60), ...entries]);
    const reading = analyzeDocument({
      schemaVersion: 1,
      hash: 'book-index',
      name: 'index.pdf',
      pageCount: 1,
      engine: 'test',
      pages: [source],
    });
    expect(
      reading.blocks.filter((b) => b.semantic === 'index').flatMap((b) => b.sourceIds),
    ).toEqual(entries.map((i) => i.id));
  });

  it('keeps two-column contents rows separate around a spanning spaced-letter section heading', () => {
    const entries = [60, 330].flatMap((x, column) =>
      Array.from({ length: 10 }, (_, row) => [
        text(`title-${column}-${row}`, `Building chapter ${row}`, x, 130 + row * 20, 130, 9),
        text(`page-${column}-${row}`, `${row + 1}`, x + 145, 130 + row * 20, 10, 9),
      ]).flat(),
    );
    const source = page([
      text('heading', 'Contents', 60, 60),
      ...entries,
      text('part', 'P A R T  I I  T H E R M A L  C O N T R O L', 200, 235, 240, 10),
    ]);
    const blocks = analyzePageSemantics(source).blocks.filter((b) => b.semantic === 'toc');
    expect(blocks).toHaveLength(20);
    expect(blocks.every((b) => b.sourceIds.length === 2)).toBe(true);
    expect(blocks.some((b) => b.sourceIds.includes('part'))).toBe(false);
    const reading = analyzeDocument({
      schemaVersion: 1,
      hash: 'contents-barrier',
      name: 'contents.pdf',
      pageCount: 1,
      engine: 'test',
      pages: [source],
    });
    expect(reading.blocks.filter((b) => b.semantic === 'toc').flatMap((b) => b.sourceIds)).toEqual(
      [
        ...entries.filter((entry) => entry.y < 235),
        ...entries.filter((entry) => entry.y >= 235),
      ].map((entry) => entry.id),
    );
  });

  it.each(['Index', '\u0001 Index', '1040 \u0001 Index'])(
    'keeps an introductory index note outside the columns under %j',
    (heading) => {
      const entries = [60, 330].flatMap((x, column) =>
        Array.from({ length: 8 }, (_, row) =>
          text(
            `entry-${column}-${row}`,
            `Building coefficient ${row + 1}`,
            x,
            150 + row * 18,
            180,
            9,
          ),
        ),
      );
      const source = page([
        text('heading', heading, 60, 60),
        text(
          'intro',
          'NOTE: references marked W refer to the online appendix and retain the same subject terms.',
          60,
          100,
          450,
          9,
        ),
        ...entries,
      ]);
      const blocks = analyzePageSemantics(source).blocks.filter((b) => b.semantic === 'index');
      expect(blocks).toHaveLength(16);
      expect(blocks.every((b) => b.sourceIds.length === 1)).toBe(true);
      expect(blocks.flatMap((b) => b.sourceIds)).not.toContain('intro');
      const reading = analyzeDocument({
        schemaVersion: 1,
        hash: 'index-intro',
        name: 'index.pdf',
        pageCount: 1,
        engine: 'test',
        pages: [source],
      });
      expect(
        reading.blocks.filter((b) => b.semantic === 'index').flatMap((b) => b.sourceIds),
      ).toEqual(entries.map((entry) => entry.id));
    },
  );
});
