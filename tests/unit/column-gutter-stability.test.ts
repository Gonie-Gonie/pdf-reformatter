import { describe, expect, it } from 'vitest';
import { persistentColumnBands } from '../../src/core/column-bands';
import type { SourcePage, SourceText } from '../../src/core/model';

function text(
  id: string,
  x: number,
  y: number,
  width: number,
  value = 'Ordinary complete prose has enough letters to support its column.',
  fontSize = 7.97,
): SourceText {
  return {
    id,
    text: value,
    x,
    y,
    width,
    height: fontSize * 1.636,
    fontSize,
    baselineY: y + fontSize * 1.1,
    fontName: 'serif',
    hasEOL: true,
  };
}

function page(items: SourceText[], width = 595): SourcePage {
  return {
    number: 1,
    width,
    height: 794,
    rotation: 0,
    items,
    graphicRegions: [],
    warnings: [],
  };
}

function indentedHeadings(leftWidth = 251): SourcePage {
  return page([
    ...Array.from({ length: 3 }, (_, row) => text(`right-top-${row}`, 307, 40 + row * 11, 251)),
    ...Array.from({ length: 3 }, (_, row) => text(`math-${row}`, 38, 40 + row * 5, 120, 'T and C')),
    ...Array.from({ length: 5 }, (_, row) => text(`left-top-${row}`, 38, 75 + row * 11, leftWidth)),
    text('heading-a', 319, 85, 180, 'A short section title'),
    text('heading-b', 319, 96, 180, 'Another short section title'),
    ...Array.from({ length: 12 }, (_, row) => [
      text(`left-${row}`, 38, 145 + row * 11, 251),
      text(`right-${row}`, 307, 145 + row * 11, 251),
    ]).flat(),
  ]);
}

describe('stable column gutters around indented headings', () => {
  it('counts operators between prose fragments before treating their gap as a column boundary', () => {
    const source = page([
      ...Array.from({ length: 6 }, (_, row) => text(`wide-${row}`, 38, 40 + row * 12, 520)),
      ...Array.from({ length: 9 }, (_, row) => [
        text(`before-${row}`, 38, 150 + row * 12, 212),
        text(`operator-${row}`, 252, 149.45 + row * 12, 16, '\u2208'),
        text(`after-${row}`, 270, 150 + row * 12, 288),
      ]).flat(),
    ]);
    const bands = persistentColumnBands(source, source.items, []);
    expect(bands.every((band) => band.gutter === undefined)).toBe(true);
    for (let row = 0; row < 9; row++) {
      const band = bands.find((entry) =>
        entry.items.some((item) => item.id === `operator-${row}`),
      )!;
      expect(band.items.some((item) => item.id === `before-${row}`)).toBe(true);
      expect(band.items.some((item) => item.id === `after-${row}`)).toBe(true);
    }
  });

  it('keeps early prose and headings in their own columns instead of inventing a wide preface', () => {
    const source = indentedHeadings();
    const bands = persistentColumnBands(source, source.items, []);
    expect(bands).toHaveLength(1);
    expect(bands[0].top).toBe(-Infinity);
    expect(bands[0].bottom).toBe(Infinity);
    expect(bands[0].gutter).toBeGreaterThan(289);
    expect(bands[0].gutter).toBeLessThan(307);
  });

  it('does not snap a genuine local shift across text occupying the page gutter', () => {
    const source = indentedHeadings(263);
    const bands = persistentColumnBands(source, source.items, []);
    const headingBand = bands.find((band) => 96 >= band.top && 96 < band.bottom)!;
    expect(headingBand.gutter).toBeGreaterThan(301);
    expect(headingBand.gutter).toBeLessThan(319);
    expect(bands.at(-1)!.gutter).toBeLessThan(307);
  });

  it('retains a wide summary and sidebar before a substantially different body gutter', () => {
    const source = page(
      [
        ...Array.from({ length: 6 }, (_, row) => [
          text(`summary-${row}`, 72, 40 + row * 12, 370, undefined, 9),
          text(`metadata-${row}`, 460, 40 + row * 12, 86, 'Publication metadata details', 9),
        ]).flat(),
        ...Array.from({ length: 8 }, (_, row) => [
          text(`body-left-${row}`, 60, 180 + row * 14, 236, undefined, 10),
          text(`body-right-${row}`, 314, 180 + row * 14, 236, undefined, 10),
        ]).flat(),
      ],
      610,
    );
    const bands = persistentColumnBands(source, source.items, []);
    expect(bands[0].gutter).toBeGreaterThan(442);
    expect(bands[0].gutter).toBeLessThan(460);
    expect(bands.at(-1)!.gutter).toBeGreaterThan(296);
    expect(bands.at(-1)!.gutter).toBeLessThan(314);
  });
});
