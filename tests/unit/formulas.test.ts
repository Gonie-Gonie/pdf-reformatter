import { describe, expect, it } from 'vitest';
import { formulaRegions } from '../../src/core/formulas';
import type { SourcePage, SourceStructure, SourceText } from '../../src/core/model';

function text(
  id: string,
  value: string,
  x: number,
  y: number,
  width: number,
  size = 8,
): SourceText {
  return {
    id,
    text: value,
    x,
    y,
    width,
    height: size * 1.5,
    fontSize: size,
    baselineY: y + size,
    fontName: 'serif',
    hasEOL: true,
  };
}
function group(id: string, sourceIds: string[], order = 0, parentId?: string): SourceStructure {
  return { id, role: 'Formula', sourceIds, order, ...(parentId ? { parentId } : {}) };
}
function page(items: SourceText[], structure: SourceStructure[]): SourcePage {
  return {
    number: 1,
    width: 600,
    height: 800,
    rotation: 0,
    items,
    structure,
    graphicRegions: [],
    warnings: [],
  };
}

describe('tagged formula regions', () => {
  it('keeps a display equation label, fraction and zero-advance marks in one crop', () => {
    const items = [
      text('label', 'PME =', 36, 100, 30),
      text('numerator', '100', 72, 94, 14),
      text('denominator', 'D', 75, 108, 7),
      text('bar', '\u20d2', 110, 94, 0),
      text('sum', '∑ max x', 90, 100, 65),
      text('prose', 'A separate paragraph after the equation.', 36, 145, 250),
    ];
    const regions = formulaRegions(
      page(items, [group('eq', ['label', 'numerator', 'denominator', 'bar', 'sum'])]),
    );
    expect(regions).toHaveLength(1);
    expect(regions[0]).toMatchObject({
      displayMath: true,
      rect: { x: 34, y: 92, width: 123, height: 30 },
    });
  });

  it('preserves an isolated formula even when it has only one baseline', () => {
    const regions = formulaRegions(
      page([text('eq', 'capture = a / b', 36, 100, 100)], [group('eq', ['eq'])]),
    );
    expect(regions).toHaveLength(1);
    expect(regions[0].displayMath).toBe(true);
  });

  it('leaves an inline power beside prose to the inline or row-preservation path', () => {
    const items = [
      text('before', 'The coefficient is', 36, 87, 111, 12),
      text('r', 'R', 150, 87, 8, 12),
      text('power', '2', 158, 79, 5, 8),
      text('after', 'on observed hours.', 167, 87, 110, 12),
    ];
    expect(formulaRegions(page(items, [group('inline', ['r', 'power'])]))).toEqual([]);
  });

  it('does not treat a paragraph in the opposite column as inline prose', () => {
    const items = [
      text('eq', 'x + y = 0', 36, 100, 250),
      ...Array.from({ length: 4 }, (_, index) =>
        text(
          `right-${index}`,
          'Ordinary prose in the opposite column.',
          306,
          100 + index * 14,
          250,
        ),
      ),
    ];
    expect(formulaRegions(page(items, [group('eq', ['eq'])]))).toHaveLength(1);
  });

  it('recognizes inline prose emitted as individual glyphs', () => {
    const items = [
      ...[...'value'].map((char, index) => text(`body-${index}`, char, 100 + index * 6, 88, 6, 12)),
      text('r', 'R', 136, 88, 8, 12),
      text('power', '2', 144, 80, 5, 8),
    ];
    expect(formulaRegions(page(items, [group('inline', ['r', 'power'])]))).toEqual([]);
  });

  it('does not count another tagged formula as surrounding prose', () => {
    const items = [text('left', 'sin', 100, 88, 30, 12), text('right', 'cos', 136, 88, 30, 12)];
    expect(
      formulaRegions(page(items, [group('left', ['left']), group('right', ['right'], 1)])),
    ).toHaveLength(2);
  });

  it('does not combine short labels on different baselines into prose evidence', () => {
    const items = Array.from({ length: 3 }, (_, index) => [
      text(`label-${index}`, 'a', 136, 88 + index * 12, 8, 12),
      text(`eq-${index}`, 'x', 150, 88 + index * 12, 8, 12),
    ]).flat();
    expect(formulaRegions(page(items, [group('eq', ['eq-0', 'eq-1', 'eq-2'])]))).toHaveLength(1);
  });

  it('lets the outer Formula own nested and duplicate member groups once', () => {
    const items = [text('a', 'a =', 36, 100, 20), text('b', 'b / c', 60, 100, 40)];
    const regions = formulaRegions(
      page(items, [
        group('inner', ['b'], 0, 'outer'),
        group('outer', ['a', 'b'], 1),
        group('duplicate', ['a', 'b'], 2),
      ]),
    );
    expect(regions).toHaveLength(1);
    expect(regions[0].rect).toMatchObject({ x: 34, width: 68 });
  });

  it('skips incomplete groups after another semantic compound has claimed a member', () => {
    const items = [text('visible', 'a = b', 36, 100, 50)];
    expect(formulaRegions(page(items, [group('partial', ['visible', 'removed'])]))).toEqual([]);
  });

  it('keeps separate tagged formulas separate', () => {
    const items = [text('first', 'x = y', 36, 100, 80), text('second', 'a = b', 306, 100, 80)];
    expect(
      formulaRegions(page(items, [group('first', ['first']), group('second', ['second'], 1)])),
    ).toHaveLength(2);
  });
});
