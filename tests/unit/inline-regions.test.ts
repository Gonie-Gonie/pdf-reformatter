import { describe, expect, it } from 'vitest';
import { protectInlineRows } from '../../src/core/inline-regions';
import type { SourcePage, SourceText } from '../../src/core/model';
import type { PreservationRegion } from '../../src/core/preservation';

function text(
  id: string,
  y: number,
  height = 10,
  value = 'A complete ordinary prose line continues here.',
): SourceText {
  return {
    id,
    text: value,
    x: 108,
    y,
    width: 396,
    height,
    fontSize: 10,
    fontName: 'serif',
    hasEOL: true,
  };
}
function line(items: SourceText[]) {
  const x = Math.min(...items.map((item) => item.x));
  const y = Math.min(...items.map((item) => item.y));
  return {
    items,
    text: items.map((item) => item.text).join(' '),
    fontSize: Math.max(...items.map((item) => item.fontSize)),
    rect: {
      x,
      y,
      width: Math.max(...items.map((item) => item.x + item.width)) - x,
      height: Math.max(...items.map((item) => item.y + item.height)) - y,
    },
  };
}
function page(items: SourceText[]): SourcePage {
  return {
    number: 4,
    width: 612,
    height: 792,
    rotation: 0,
    items,
    graphicRegions: [],
    warnings: [],
  };
}
function seed(y = 518.129, height = 19.551): PreservationRegion {
  return {
    rect: { x: 106, y, width: 400, height },
    reason: '수식 또는 첨자가 포함된 줄을 원문 모양으로 보존',
  };
}

describe('inline fractions beside ordinary source rows', () => {
  it('owns complete adjacent rows whose glyph boxes overlap a raised and lowered fraction', () => {
    const before = text('before', 511.228, 9.963);
    const prose = text('prose', 522.137, 9.963);
    const numerator = {
      ...text('numerator', 520.129, 6.974, '1'),
      x: 125,
      width: 4,
      fontSize: 6.974,
    };
    const lower = { ...text('lower', 530.699, 4.981, 'k'), x: 130, width: 4, fontSize: 4.981 };
    const after = text('after', 535.307, 9.963);
    const outerBefore = text('outer-before', 500.319, 9.963);
    const outerAfter = text('outer-after', 546.216, 9.963);
    const items = [outerBefore, before, prose, numerator, lower, after, outerAfter];
    const source = page(items);
    const original = seed();
    const result = protectInlineRows(
      source,
      [
        line([outerBefore]),
        line([before]),
        { ...line([prose, numerator, lower]), fontSize: 6.974 },
        line([after]),
        line([outerAfter]),
      ],
      [original],
    );
    expect(result[0].inlineRows).toBe(true);
    expect(result[0].rect.y).toBeCloseTo(509.228);
    expect(result[0].rect.y + result[0].rect.height).toBeCloseTo(547.27);
    expect(original.rect.y).toBe(518.129);
  });

  it('leaves a normal nonoverlapping one-line crop unchanged', () => {
    const items = [text('before', 100), text('body', 112), text('after', 124)];
    const original = seed(110, 14);
    expect(
      protectInlineRows(
        page(items),
        items.map((item) => line([item])),
        [original],
      ),
    ).toEqual([original]);
  });

  it('marks an already multiline inline crop for safe outer-edge trimming without expanding it', () => {
    const items = [text('first', 100), text('second', 112), text('after', 125)];
    const original = seed(98, 26);
    const result = protectInlineRows(
      page(items),
      items.map((item) => line([item])),
      [original],
    );
    expect(result[0]).toEqual({ ...original, inlineRows: true });
  });

  it('allows a compact radical drawing supported by a nearby mathematical glyph', () => {
    const first = text('first', 100);
    const second = text('second', 112);
    const radical = { ...text('radical', 104, 10, '√'), x: 250, width: 8 };
    const after = text('after', 125);
    const source = page([first, radical, second, after]);
    source.graphicRegions = [{ x: 249, y: 113, width: 9, height: 9 }];
    const original = seed(98, 26);
    expect(
      protectInlineRows(
        source,
        [line([first]), line([radical]), line([second]), line([after])],
        [original],
      )[0],
    ).toEqual({ ...original, inlineRows: true });
  });

  it('does not cross columns or absorb headings, captions or illustrations', () => {
    const body = text('body', 112, 14);
    const otherColumn = { ...text('other', 120), x: 520, width: 70 };
    const original = seed(110, 18);
    expect(
      protectInlineRows(page([body, otherColumn]), [line([body]), line([otherColumn])], [original]),
    ).toEqual([original]);
    for (const value of ['Figure 2: A separate illustration.', '3.2 A section heading']) {
      const candidate = text('candidate', 124, 10, value);
      expect(
        protectInlineRows(page([body, candidate]), [line([body]), line([candidate])], [original]),
      ).toEqual([original]);
    }
    const source = page([body]);
    source.graphicRegions = [{ x: 120, y: 118, width: 20, height: 5 }];
    expect(protectInlineRows(source, [line([body])], [original])).toEqual([original]);
  });

  it('does not expand display equations or other preservation reasons', () => {
    const items = [text('body', 112, 15), text('after', 125)];
    for (const original of [
      { ...seed(110, 20), displayMath: true },
      { ...seed(110, 20), reason: 'A figure or equation frame' },
    ]) {
      expect(
        protectInlineRows(
          page(items),
          items.map((item) => line([item])),
          [original],
        ),
      ).toEqual([original]);
    }
  });

  it('does not grow an overlapping chain beyond four source rows', () => {
    const items = Array.from({ length: 6 }, (_, index) =>
      text('row-' + index, 100 + index * 9, 10),
    );
    const original = seed(116, 14);
    expect(
      protectInlineRows(
        page(items),
        items.map((item) => line([item])),
        [original],
      ),
    ).toEqual([original]);
  });
});
