import { describe, expect, it } from 'vitest';
import { matrixRegions } from '../../src/core/matrix-regions';
import type { SourcePage, SourceText } from '../../src/core/model';
import { ownsPreservedText } from '../../src/core/preservation';

function item(id: string, value: string, x: number, y: number, width = 5): SourceText {
  return {
    id,
    text: value,
    x,
    y,
    width,
    height: 10,
    fontSize: 10,
    baselineY: y + 7,
    fontName: 'serif',
    hasEOL: false,
  };
}

function vector(prefix: string, x: number, y: number, values = ['x', 'y', 'z']): SourceText[] {
  const extra = values.length - 3;
  const parts = [
    { suffix: 'top', y, left: '\uf8eb', right: '\uf8f6' },
    ...Array.from({ length: 1 + extra * 2 }, (_, index) => ({
      suffix: `middle-${index}`,
      y: y + 17.5 + index * 6,
      left: '\uf8ec',
      right: '\uf8f7',
    })),
    { suffix: 'bottom', y: y + 23.9 + extra * 12, left: '\uf8ed', right: '\uf8f8' },
  ];
  return [
    ...parts.flatMap((part) => [
      item(`${prefix}-left-${part.suffix}`, part.left, x, part.y, 8.7),
      item(`${prefix}-right-${part.suffix}`, part.right, x + 14, part.y, 8.7),
    ]),
    ...values.map((value, row) =>
      item(`${prefix}-cell-${row}`, value, x + 9, y + 3.3 + row * 13.47),
    ),
  ];
}

function regions(items: SourceText[]) {
  const page: SourcePage = {
    number: 1,
    width: 540,
    height: 666,
    rotation: 0,
    items,
    graphicRegions: [],
    warnings: [],
  };
  return matrixRegions(
    page,
    items.map((entry) => ({
      items: [entry],
      rect: entry,
      text: entry.text,
      fontSize: entry.fontSize,
    })),
  );
}

describe('untagged matrix preservation', () => {
  it('preserves all five rows and their extensible parentheses with an adjacent equality as one object', () => {
    const math = [
      ...vector('left', 200, 80, ['x', 'y', 'z', 'w', 'u']),
      item('equality', '=', 231, 108, 8),
      ...vector('right', 247, 80, ['0', '4', '0', '0', '0']),
    ];
    const before = item('before', 'The preceding ordinary paragraph stays editable.', 60, 58, 320);
    const after = item(
      'after',
      'The following ordinary paragraph also stays editable.',
      60,
      170,
      320,
    );
    const found = regions([before, ...math, after]);
    expect(found).toHaveLength(1);
    expect(found[0].displayMath).toBe(true);
    expect(math.every((entry) => ownsPreservedText(found[0].rect, entry))).toBe(true);
    expect(ownsPreservedText(found[0].rect, before)).toBe(false);
    expect(ownsPreservedText(found[0].rect, after)).toBe(false);
    expect(found[0].rect.height).toBeLessThan(80);
  });

  it('accepts complete Unicode delimiters and keeps a short final row inside their crop', () => {
    const math = vector('unicode', 200, 80).map((entry) => ({
      ...entry,
      text: entry.text
        .replace('\uf8eb', '\u239b')
        .replace('\uf8ec', '\u239c')
        .replace('\uf8ed', '\u239d')
        .replace('\uf8f6', '\u239e')
        .replace('\uf8f7', '\u239f')
        .replace('\uf8f8', '\u23a0'),
    }));
    const found = regions(math);
    expect(found).toHaveLength(1);
    expect(math.every((entry) => ownsPreservedText(found[0].rect, entry))).toBe(true);
  });

  it('keeps several numeric columns and fractional entries together with all matrix rows', () => {
    const brackets = vector('matrix', 100, 80)
      .filter((entry) => !entry.id.includes('-cell-'))
      .map((entry) => ({
        ...entry,
        x: entry.id.includes('-right-') ? entry.x + 54 : entry.x,
      }));
    const math = [
      ...brackets,
      ...Array.from({ length: 3 }, (_, row) =>
        ['1', '−2', '1/3'].map((value, column) =>
          item(`cell-${row}-${column}`, value, 110 + column * 18, 83.3 + row * 13.47, 12),
        ),
      ).flat(),
    ];
    const found = regions(math);
    expect(found).toHaveLength(1);
    expect(math.every((entry) => ownsPreservedText(found[0].rect, entry))).toBe(true);
  });

  it('accepts paired single tall bracket glyphs around several ordinary-sized rows', () => {
    const math = [
      { ...item('left', '[', 100, 100, 6), height: 40, fontSize: 40 },
      ...['x', 'y', 'z'].map((value, row) => item(`cell-${row}`, value, 112, 103 + row * 13.47)),
      { ...item('right', ']', 130, 100, 6), height: 40, fontSize: 40 },
    ];
    const found = regions(math);
    expect(found).toHaveLength(1);
    expect(math.every((entry) => ownsPreservedText(found[0].rect, entry))).toBe(true);
  });

  it('does not turn ordinary parenthesized prose or a list into a preserved equation', () => {
    const prose = [
      item('opening', '(', 60, 80),
      item('first', 'An ordinary paragraph continues on this line.', 70, 80, 300),
      item('second', 'The following paragraph line has ordinary words.', 70, 94, 300),
      item('closing', ')', 375, 94),
      item('list-one', '(1) The first item in an ordinary numbered list.', 60, 130, 320),
      item('list-two', '(2) The second item in an ordinary numbered list.', 60, 144, 320),
    ];
    expect(regions(prose)).toEqual([]);
    expect(
      regions(
        vector('prose-frame', 100, 200, ['ordinary words', 'additional prose', 'another sentence']),
      ),
    ).toEqual([]);
  });

  it('keeps separate matrices apart when ordinary words appear between them', () => {
    const first = vector('first', 100, 80);
    const second = vector('second', 200, 80);
    const prose = item('prose', 'ordinary connecting prose', 130, 96, 64);
    const found = regions([...first, prose, ...second]);
    expect(found).toHaveLength(2);
    expect(found.every((region) => !ownsPreservedText(region.rect, prose))).toBe(true);
  });

  it('requires a complete paired delimiter and multiple cell rows', () => {
    const incomplete = vector('broken', 100, 80).filter(
      (entry) => entry.id !== 'broken-right-bottom',
    );
    expect(regions(incomplete)).toEqual([]);
    expect(regions(vector('one-row', 100, 80, ['x']))).toEqual([]);
  });
});
