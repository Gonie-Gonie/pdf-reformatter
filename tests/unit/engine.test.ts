import { describe, expect, it } from 'vitest';
import { analyzeDocument, applyOverrides } from '../../src/core/analyze';
import { DEFAULT_CONFIG, validateConfig } from '../../src/core/config';
import { contentWidth } from '../../src/core/geometry';
import { layoutDocument, wrapText } from '../../src/core/layout';
import type { ReadingDocument, SourceDocument, SourcePage, SourceText } from '../../src/core/model';

function item(id: string, text: string, x = 36, y = 40, width = 230, fontSize = 12): SourceText {
  return { id, text, x, y, width, height: fontSize, fontSize, fontName: 'NotoSerif', hasEOL: true };
}
function page(items: SourceText[]): SourcePage {
  return {
    number: 1,
    width: 612,
    height: 792,
    rotation: 0,
    items,
    graphicRegions: [],
    warnings: [],
  };
}
function source(pages: SourcePage[]): SourceDocument {
  return {
    schemaVersion: 1,
    hash: 'hash',
    name: 'synthetic.pdf',
    pageCount: pages.length,
    pages,
    engine: 'test',
  };
}
const measure = (value: string, size: number) => [...value].length * size * 0.53;
function reading(
  text = 'A paragraph with enough words to flow over lines. '.repeat(30),
): ReadingDocument {
  return {
    schemaVersion: 1,
    sourceHash: 'hash',
    warnings: [],
    blocks: [
      {
        id: 'b1',
        kind: 'paragraph',
        sourcePage: 1,
        sourceIds: ['i1'],
        rect: { x: 36, y: 40, width: 500, height: 700 },
        rawText: text,
        text,
        fontSize: 12,
        confidence: 'high',
      },
    ],
  };
}

describe('configuration and geometry', () => {
  it('retains the documented Fold7 point geometry', () => {
    expect(contentWidth(492, 34, 34)).toBe(424);
    expect(validateConfig(DEFAULT_CONFIG)).toEqual(DEFAULT_CONFIG);
  });
  it.each([
    { ...DEFAULT_CONFIG, marginLeftPt: 500 },
    { ...DEFAULT_CONFIG, marginTopPt: 500 },
    { ...DEFAULT_CONFIG, pageWidthPt: NaN },
    { ...DEFAULT_CONFIG, fontSizePt: Infinity },
    { ...DEFAULT_CONFIG, lineHeightPt: 1 },
    { ...DEFAULT_CONFIG, paragraphGapPt: -1 },
    { ...DEFAULT_CONFIG, fontFamily: 'unknown' },
  ])('rejects invalid imported configuration %#', (invalid) => {
    expect(() => validateConfig(invalid)).toThrow(RangeError);
  });
  it('rejects impossible and non-finite widths', () => {
    expect(() => contentWidth(100, 60, 60)).toThrow(RangeError);
    expect(() => contentWidth(NaN, 0, 0)).toThrow(RangeError);
    expect(() => contentWidth(100, -1, 0)).toThrow(RangeError);
  });
});

describe('source analysis and ownership', () => {
  it('reconstructs a paragraph and keeps the raw line breaks separately', () => {
    const document = analyzeDocument(
      source([
        page([
          item('1', 'This is the first line of a paragraph'),
          item('2', 'and this is its second line.', 36, 57),
        ]),
      ]),
    );
    expect(document.blocks).toHaveLength(1);
    expect(document.blocks[0].text).toBe(
      'This is the first line of a paragraph and this is its second line.',
    );
    expect(document.blocks[0].rawText).toContain('\n');
    expect(document.blocks[0].sourceIds).toEqual(['1', '2']);
  });
  it('keeps line-end hyphens without silent lexical reconstruction', () => {
    const document = analyzeDocument(
      source([
        page([item('1', 'A hyphenated techni-'), item('2', 'cal word remains explicit.', 36, 57)]),
      ]),
    );
    expect(document.blocks[0].text).toContain('techni- cal');
  });
  it('orders two columns left to right while keeping a full-width heading', () => {
    const input = page([
      item('title', 'A Full Width Heading', 36, 15, 540, 18),
      item('r1', 'Right first line', 324, 60, 245),
      item('l1', 'Left first line', 36, 60, 245),
      item('r2', 'Right second line', 324, 78, 245),
      item('l2', 'Left second line', 36, 78, 245),
      item('r3', 'Right final line.', 324, 96, 245),
      item('l3', 'Left final line.', 36, 96, 245),
    ]);
    const result = analyzeDocument(source([input]));
    expect(result.blocks[0].kind).toBe('heading');
    const order = result.blocks.flatMap((block) => block.sourceIds);
    expect(order).toEqual(['title', 'l1', 'l2', 'l3', 'r1', 'r2', 'r3']);
    expect(result.warnings.some((warning) => warning.includes('2단'))).toBe(true);
  });
  it('preserves inline mathematical lines and gives their text one owner', () => {
    const input = page([
      item('a', 'This is normal prose before the equation.', 36, 40),
      item('b', 'The expression x ≤ y is kept intact.', 36, 60),
      item('c', 'Normal prose resumes below the equation.', 36, 82),
    ]);
    const result = analyzeDocument(source([input]));
    const regions = result.blocks.filter((block) => block.kind === 'sourceRegion');
    expect(regions).toHaveLength(1);
    expect(regions[0].sourceIds).toEqual(['b']);
    expect(result.blocks.flatMap((block) => block.sourceIds).sort()).toEqual(['a', 'b', 'c']);
  });
  it('keeps split display equations, fraction rules and their number in one visual block', () => {
    const input = page([
      item('left1', 'This is ordinary prose in the left column.', 48, 480, 243, 10.5),
      item('right1', 'This is ordinary prose in the right column.', 321, 480, 243, 10.5),
      item('left2', 'The column continues before the equation.', 48, 496, 243, 10.5),
      item('right2', 'More prose continues before the equation.', 321, 496, 243, 10.5),
      { ...item('energy', 'E = mc²', 145, 553.44, 55.024, 16), height: 23.168 },
      { ...item('inequality', 'x ≤ y', 225.112, 553.44, 39.472, 16), height: 23.168 },
      { ...item('sum', '∑ x = 10', 289.672, 553.44, 61.36, 16), height: 23.168 },
      { ...item('numerator', 'a + b', 257, 594.034, 31.584, 14), height: 19.068 },
      { ...item('denominator', 'c + d', 257, 619.034, 30.59, 14), height: 19.068 },
      { ...item('equation-number', '(1)', 525, 602.241, 13.761, 11), height: 14.982 },
      {
        ...item(
          'caption',
          'Equation 1. Original symbols and fraction geometry are test content.',
          80,
          656.31,
          325.36,
          10,
        ),
        height: 13.62,
      },
    ]);
    input.graphicRegions.push(
      { x: 242, y: 608, width: 20, height: 14 },
      { x: 284, y: 608, width: 26, height: 14 },
    );
    const result = analyzeDocument(source([input]));
    const regions = result.blocks.filter((block) => block.kind === 'sourceRegion');
    expect(regions).toHaveLength(1);
    expect(regions[0].sourceIds.sort()).toEqual(
      ['energy', 'inequality', 'sum', 'numerator', 'denominator', 'equation-number'].sort(),
    );
    expect(regions[0].confidence).toBe('review');
    expect(result.blocks.find((block) => block.sourceIds.includes('caption'))?.kind).toBe(
      'caption',
    );
    expect(result.blocks.find((block) => block.sourceIds.includes('left1'))?.kind).toBe(
      'paragraph',
    );
    expect(result.warnings.some((warning) => warning.includes('수식·번호'))).toBe(true);
    expect(result.blocks.flatMap((block) => block.sourceIds).length).toBe(input.items.length);
  });
  it('detects a narrow column gutter before same-baseline runs are joined', () => {
    const input = page([
      item('l1', 'Left first line', 40, 60, 258),
      item('r1', 'Right first line', 322, 60, 245),
      item('l2', 'Left second line', 40, 78, 258),
      item('r2', 'Right second line', 322, 78, 245),
      item('l3', 'Left final line.', 40, 96, 258),
      item('r3', 'Right final line.', 322, 96, 245),
    ]);
    const ids = analyzeDocument(source([input])).blocks.flatMap((block) => block.sourceIds);
    expect(ids).toEqual(['l1', 'l2', 'l3', 'r1', 'r2', 'r3']);
  });
  it('expands graphics to intersecting text without duplicate reflow', () => {
    const input = page([
      item('body', 'Body text above the table.', 36, 40),
      item('table', 'Text inside table', 44, 102),
      item('caption', 'Figure 1. Caption', 36, 150),
    ]);
    input.graphicRegions.push({ x: 40, y: 95, width: 240, height: 35 });
    const result = analyzeDocument(source([input]));
    const region = result.blocks.find((block) => block.kind === 'sourceRegion')!;
    expect(region.sourceIds).toEqual(['table']);
    expect(result.blocks.find((block) => block.sourceIds.includes('caption'))?.kind).toBe(
      'caption',
    );
    expect(new Set(result.blocks.flatMap((block) => block.sourceIds)).size).toBe(3);
  });
  it('preserves a scanned page without inventing OCR text', () => {
    const result = analyzeDocument(source([page([])]));
    expect(result.blocks[0].kind).toBe('sourceRegion');
    expect(result.blocks[0].rect).toEqual({ x: 0, y: 0, width: 612, height: 792 });
    expect(result.warnings[0]).toContain('텍스트가 없어');
  });
  it.each([90, 180, 270])('falls back safely for %i degree pages', (rotation) => {
    const input = page([item('1', 'Rotated source')]);
    input.rotation = rotation;
    const result = analyzeDocument(source([input]));
    expect(result.blocks[0].kind).toBe('sourceRegion');
    expect(result.blocks[0].sourceIds).toEqual(['1']);
  });
  it('retains a repeated page header instead of silently deleting it', () => {
    const first = page([
      item('h1', 'Repeated running header'),
      item('b1', 'First page body', 36, 100),
    ]);
    const second = {
      ...page([item('h2', 'Repeated running header'), item('b2', 'Second page body', 36, 100)]),
      number: 2,
    };
    const result = analyzeDocument(source([first, second]));
    expect(result.blocks.flatMap((block) => block.sourceIds).sort()).toEqual([
      'b1',
      'b2',
      'h1',
      'h2',
    ]);
  });
  it('keeps source analysis immutable when applying review corrections', () => {
    const input = reading('Original');
    const corrected = applyOverrides(input, {
      b1: { text: 'Corrected', kind: 'heading', order: 1 },
    });
    expect(corrected.blocks[0].text).toBe('Corrected');
    expect(corrected.blocks[0].rawText).toBe('Original');
    expect(input.blocks[0].text).toBe('Original');
    expect(applyOverrides(input, { b1: { excluded: true } }).blocks).toHaveLength(0);
    expect(applyOverrides(input, { missing: { text: 'Unused' } }).warnings).toHaveLength(1);
  });
});

describe('measured reflow and pagination', () => {
  it('reflows with actual measured width and preserves long URL spelling', () => {
    const url = 'https://example.test/' + 'long-path-'.repeat(20);
    const lines = wrapText(url, 100, 12, measure);
    expect(lines.join('')).toBe(url);
    expect(lines.every((line) => measure(line, 12) <= 100.001)).toBe(true);
  });
  it('wraps CJK and combining marks without losing code points', () => {
    const value = '한글과漢字とひらがな' + 'e\u0301'.repeat(12);
    const lines = wrapText(value, 60, 12, measure);
    expect(lines.join('')).toBe(value);
    expect(lines.some((line) => /^\p{Mark}/u.test(line))).toBe(false);
  });
  it('uses width from the caller rather than a fixed character count', () => {
    const result = wrapText('WWW iii WWW iii', 55, 10, (text) =>
      [...text].reduce((sum, char) => sum + (char === 'W' ? 12 : 2), 0),
    );
    expect(result[0]).toBe('WWW iii');
  });
  it('paginates long paragraphs with no overlap or empty output pages', () => {
    const result = layoutDocument(reading(), DEFAULT_CONFIG, measure);
    expect(result.pages.length).toBeGreaterThan(1);
    for (const output of result.pages) {
      expect(output.placements.length).toBeGreaterThan(0);
      for (let index = 1; index < output.placements.length; index++) {
        const current = output.placements[index];
        const previous = output.placements[index - 1];
        expect(current.y + 0.001).toBeGreaterThanOrEqual(previous.y + previous.height);
      }
    }
    const text = result.pages
      .flatMap((output) =>
        output.placements.map((placement) => (placement.type === 'text' ? placement.text : '')),
      )
      .join(' ');
    expect(text.replace(/\s+/gu, '')).toBe(reading().blocks[0].text.replace(/\s+/gu, ''));
  });
  it.each([
    [360, 640, 11, 20],
    [492, 546, 13.2, 34],
    [600, 800, 16, 34],
  ])(
    'retains content with %i×%i pt, %f pt text and %i pt margins',
    (width, height, size, margin) => {
      const input = reading();
      const before = JSON.stringify(input);
      const result = layoutDocument(
        input,
        {
          ...DEFAULT_CONFIG,
          pageWidthPt: width,
          pageHeightPt: height,
          fontSizePt: size,
          lineHeightPt: size * 1.6,
          marginLeftPt: margin,
          marginRightPt: margin,
        },
        measure,
      );
      expect(JSON.stringify(input)).toBe(before);
      expect(
        result.pages
          .flatMap((output) => output.placements)
          .every((placement) => placement.blockId === 'b1'),
      ).toBe(true);
    },
  );
  it('fits an oversized indivisible diagram on one page without looping', () => {
    const input = reading();
    input.blocks[0].kind = 'sourceRegion';
    input.blocks[0].rect = { x: 10, y: 20, width: 1000, height: 5000 };
    const result = layoutDocument(input, DEFAULT_CONFIG, measure);
    expect(result.pages).toHaveLength(1);
    const placement = result.pages[0].placements[0];
    expect(placement.height / placement.width).toBeCloseTo(5);
    expect(result.warnings.some((warning) => warning.includes('축소'))).toBe(true);
  });
  it('rejects unplaceable glyphs rather than clipping them', () => {
    expect(() => wrapText('W', 10, 12, () => 100)).toThrow(RangeError);
  });
  it('rejects an empty all-excluded document', () => {
    const empty = { ...reading(), blocks: [] };
    expect(() => layoutDocument(empty, DEFAULT_CONFIG, measure)).toThrow('출력할 내용이 없습니다');
  });
});
