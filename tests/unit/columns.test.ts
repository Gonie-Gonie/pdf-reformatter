import { describe, expect, it } from 'vitest';
import { findColumnGutter } from '../../src/core/columns';
import type { SourceText } from '../../src/core/model';

function run(id: string, text: string, x: number, y: number, width: number, size = 8): SourceText {
  return {
    id,
    text,
    x,
    y,
    width,
    height: size * 1.6,
    fontSize: size,
    fontName: 'serif',
    hasEOL: true,
  };
}

describe('column whitespace', () => {
  it('finds a narrow gutter despite dense starts inside fragmented prose', () => {
    const items = Array.from({ length: 8 }, (_, row) =>
      [38, 72, 108, 144, 180, 216, 252, 307, 342, 378, 414, 450, 486, 522].map((x, col) =>
        run(`${row}-${col}`, 'words here', x, 50 + row * 10.5, col === 6 || col === 13 ? 35 : 30),
      ),
    ).flat();
    const gutter = findColumnGutter(items, 595);
    expect(gutter).toBeGreaterThan(287);
    expect(gutter).toBeLessThan(307);
  });

  it('keeps full-width headings and captions outside the supporting prose band', () => {
    const items = [
      run('heading', 'A heading spans both columns', 38, 20, 520, 16),
      ...Array.from({ length: 4 }, (_, row) => [
        run(`left-${row}`, 'Ordinary prose in the first column', 38, 65 + row * 14, 250),
        run(`right-${row}`, 'Ordinary prose in the second column', 307, 65 + row * 14, 250),
      ]).flat(),
      run('caption', 'Figure 1. A caption spanning the page', 38, 150, 520),
    ];
    const gutter = findColumnGutter(items, 595);
    expect(gutter).toBeGreaterThan(288);
    expect(gutter).toBeLessThan(307);
  });

  it('supports unequal column widths without a centered-page assumption', () => {
    const items = Array.from({ length: 4 }, (_, row) => [
      run(`left-${row}`, 'A narrow prose sidebar', 38, 60 + row * 14, 140),
      run(`right-${row}`, 'A wider abstract or main text continues here', 202, 60 + row * 14, 355),
    ]).flat();
    const gutter = findColumnGutter(items, 595);
    expect(gutter).toBeGreaterThan(178);
    expect(gutter).toBeLessThan(202);
  });

  it('keeps a narrow keyword sidebar separate from a wider abstract', () => {
    const items = Array.from({ length: 5 }, (_, row) => [
      run(`left-${row}`, 'Forecast evaluation', 38, 60 + row * 10, 55, 6.4),
      run(
        `right-${row}`,
        'A wide abstract line with ordinary prose continues here',
        202,
        60 + row * 10,
        355,
      ),
    ]).flat();
    const gutter = findColumnGutter(items, 595);
    expect(gutter).toBeGreaterThan(93);
    expect(gutter).toBeLessThan(202);
  });

  it('detects columns whose independent baselines are vertically staggered', () => {
    const items = Array.from({ length: 6 }, (_, row) => [
      run(`left-${row}`, 'Ordinary prose in the first column', 38, 60 + row * 14, 250),
      run(`right-${row}`, 'Ordinary prose in the second column', 307, 67 + row * 14, 250),
    ]).flat();
    const gutter = findColumnGutter(items, 595);
    expect(gutter).toBeGreaterThan(288);
    expect(gutter).toBeLessThan(307);
  });

  it('does not count nearby-row windows twice as independent column evidence', () => {
    const items = [
      run('left-start', 'An isolated', 38, 60, 90),
      run('left-end', 'fragmented row', 130, 60, 158),
      run('right-start', 'Another isolated', 307, 67, 110),
      run('right-end', 'fragmented row', 419, 67, 138),
    ];
    expect(findColumnGutter(items, 595)).toBeUndefined();
  });

  it('does not split a prose column at staggered cells in a later table', () => {
    const items = [
      ...Array.from({ length: 3 }, (_, row) =>
        run(
          `prose-${row}`,
          'An existing column of ordinary prose continues here',
          307,
          60 + row * 14,
          250,
        ),
      ),
      ...Array.from({ length: 4 }, (_, row) => [
        run(`table-left-${row}`, 'Descriptive table label', 320, 130 + row * 14, 100),
        run(`table-right-${row}`, 'Another table label', 440, 137 + row * 14, 90),
      ]).flat(),
    ];
    expect(findColumnGutter(items, 595)).toBeUndefined();
  });

  it('does not mistake numeric table cells or marginal line numbers for prose columns', () => {
    const items = Array.from({ length: 5 }, (_, row) => [
      run(`label-${row}`, 'Annual forecast evaluation', 38, 60 + row * 14, 230),
      run(`value-${row}`, '12.34', 307, 60 + row * 14, 60),
      run(`number-${row}`, String(row + 1), 565, 60 + row * 14, 10),
    ]).flat();
    expect(findColumnGutter(items, 595)).toBeUndefined();
  });

  it('does not infer columns from ordinary spaces in a single fragmented paragraph', () => {
    const items = Array.from({ length: 6 }, (_, row) =>
      Array.from({ length: 12 }, (_, col) =>
        run(`${row}-${col}`, 'word', 38 + col * 42 + (row % 3) * 2, 60 + row * 14, 39),
      ),
    ).flat();
    expect(findColumnGutter(items, 595)).toBeUndefined();
  });

  it('distinguishes regularly wide word spaces from a column boundary', () => {
    const items = Array.from({ length: 6 }, (_, row) =>
      Array.from({ length: 10 }, (_, col) =>
        run(`${row}-${col}`, 'words', 38 + col * 50, 60 + row * 14, 38),
      ),
    ).flat();
    expect(findColumnGutter(items, 595)).toBeUndefined();
  });

  it('keeps reference labels on the same side as their text', () => {
    const items = Array.from({ length: 4 }, (_, row) => [
      run(`left-${row}`, 'The earlier reference continues here', 54, 60 + row * 14, 232),
      run(`label-${row}`, `[${46 + row}]`, 307, 60 + row * 14, 13),
      run(`right-${row}`, 'The next reference starts and continues here', 323, 60 + row * 14, 232),
    ]).flat();
    const gutter = findColumnGutter(items, 595);
    expect(gutter).toBeGreaterThan(286);
    expect(gutter).toBeLessThan(307);
  });

  it('requires evidence at more than one baseline', () => {
    expect(
      findColumnGutter(
        [
          run('left', 'A single isolated row', 38, 60, 250),
          run('right', 'On the opposite side', 307, 60, 250),
        ],
        595,
      ),
    ).toBeUndefined();
  });

  it('uses a substantial figure opposite three prose rows as column evidence', () => {
    const items = Array.from({ length: 3 }, (_, row) =>
      run(
        `right-${row}`,
        'Ordinary prose beside the figure continues here',
        307,
        276 + row * 14,
        250,
      ),
    );
    const gutter = findColumnGutter(items, 595, [{ x: 39, y: 265, width: 248, height: 206 }]);
    expect(gutter).toBeGreaterThan(287);
    expect(gutter).toBeLessThan(307);
  });

  it('also supports a substantial figure on the right of prose', () => {
    const items = Array.from({ length: 4 }, (_, row) =>
      run(
        `left-${row}`,
        'Ordinary prose beside the figure continues here',
        38,
        276 + row * 14,
        250,
      ),
    );
    const gutter = findColumnGutter(items, 595, [{ x: 307, y: 265, width: 248, height: 206 }]);
    expect(gutter).toBeGreaterThan(288);
    expect(gutter).toBeLessThan(307);
  });

  it('does not infer a column from a full-width figure above single-column prose', () => {
    const items = Array.from({ length: 4 }, (_, row) =>
      run(`body-${row}`, 'Ordinary prose beneath a full-width figure', 38, 300 + row * 14, 520),
    );
    expect(
      findColumnGutter(items, 595, [{ x: 38, y: 60, width: 520, height: 180 }]),
    ).toBeUndefined();
  });

  it('requires three overlapping prose rows beside a figure', () => {
    const items = Array.from({ length: 2 }, (_, row) =>
      run(
        `right-${row}`,
        'Only two prose lines appear beside the figure',
        307,
        276 + row * 14,
        250,
      ),
    );
    expect(
      findColumnGutter(items, 595, [{ x: 39, y: 265, width: 248, height: 206 }]),
    ).toBeUndefined();
  });

  it('rejects a proposed figure gutter crossed by actual prose', () => {
    const items = [
      ...Array.from({ length: 3 }, (_, row) =>
        run(
          `right-${row}`,
          'Ordinary prose beside the figure continues here',
          307,
          276 + row * 14,
          250,
        ),
      ),
      run('crossing', 'This prose crosses the proposed boundary', 280, 340, 180),
    ];
    expect(
      findColumnGutter(items, 595, [{ x: 39, y: 265, width: 248, height: 206 }]),
    ).toBeUndefined();
  });
});
