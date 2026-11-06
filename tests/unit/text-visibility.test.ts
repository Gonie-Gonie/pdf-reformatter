import { describe, expect, it } from 'vitest';
import { visibleTextItems } from '../../src/adapters/pdf/text-visibility';
import type { SourceText } from '../../src/core/model';

const ops = {
  save: 1,
  restore: 2,
  transform: 3,
  paintFormXObjectBegin: 4,
  paintFormXObjectEnd: 5,
  beginGroup: 6,
  endGroup: 7,
  setFont: 8,
  setTextRenderingMode: 9,
  setFillGray: 10,
  setFillRGBColor: 11,
  showText: 12,
  showSpacedText: 13,
  nextLineShowText: 14,
  nextLineSetSpacingShowText: 15,
};
const page = { width: 100, height: 100 };
const identity = [1, 0, 0, 1, 0, 0];
function item(id: string, x: number, y: number, font = 'embedded', width = 10): SourceText {
  return {
    id,
    text: id,
    x,
    y,
    width,
    height: 8,
    fontSize: 8,
    fontName: `serif ${font}`,
    hasEOL: true,
  };
}
function list(...operations: [number, unknown[]][]) {
  return { fnArray: operations.map(([op]) => op), argsArray: operations.map(([, args]) => args) };
}
function raster() {
  return {
    width: 100,
    height: 100,
    scale: 1,
    pixels: new Uint8ClampedArray(100 * 100 * 4).fill(255),
  };
}

describe('painted PDF text visibility', () => {
  it('drops hidden paragraphs outside an embedded PDF crop while retaining its visible labels', () => {
    const operations = list(
      [ops.paintFormXObjectBegin, [null, new Float32Array([20, 20, 80, 80])]],
      [ops.setFont, ['embedded', 8]],
      [ops.showText, [[]]],
      [ops.paintFormXObjectEnd, []],
    );
    const result = visibleTextItems(
      [item('hidden-draft', 5, 5), item('visible-label', 30, 30), item('body', 5, 90, 'body')],
      operations,
      ops,
      identity,
      page,
      raster(),
    );
    expect(result.map((entry) => entry.id)).toEqual(['visible-label', 'body']);
  });

  it('preserves a partially clipped text run as only its visible source crop', () => {
    const operations = list(
      [ops.paintFormXObjectBegin, [null, [20, 20, 80, 80]]],
      [ops.setFont, ['embedded', 8]],
      [ops.showText, [[]]],
      [ops.paintFormXObjectEnd, []],
    );
    const [result] = visibleTextItems(
      [item('partial', 70, 30, 'embedded', 20)],
      operations,
      ops,
      identity,
      page,
      raster(),
    );
    expect(result).toMatchObject({ x: 70, y: 30, width: 10, height: 8, preserve: true });
  });

  it('does not assign one Form clip to a font also used outside that Form', () => {
    const operations = list(
      [ops.setFont, ['embedded', 8]],
      [ops.showText, [[]]],
      [ops.paintFormXObjectBegin, [null, [20, 20, 80, 80]]],
      [ops.showText, [[]]],
      [ops.paintFormXObjectEnd, []],
    );
    const body = item('body', 5, 5);
    expect(visibleTextItems([body], operations, ops, identity, page, raster())).toEqual([body]);
  });

  it('retains zero-advance combining marks within a Form clip', () => {
    const operations = list(
      [ops.paintFormXObjectBegin, [null, [20, 20, 80, 80]]],
      [ops.setFont, ['embedded', 8]],
      [ops.showText, [[]]],
      [ops.paintFormXObjectEnd, []],
    );
    const inside = { ...item('hat', 42, 36, 'embedded', 0), text: '\u0302' };
    const partial = { ...item('partial', 42, 76, 'embedded', 0), text: '\u0302' };
    const result = visibleTextItems(
      [item('base', 40, 40), inside, partial, item('outside', 10, 36, 'embedded', 0)],
      operations,
      ops,
      identity,
      page,
      raster(),
    );
    expect(result.map((entry) => entry.id)).toEqual(['base', 'hat', 'partial']);
    expect(result[1]).toEqual(inside);
    expect(result[2]).toMatchObject({ x: 42, y: 76, width: 0, height: 4 });
  });

  it('removes white text on blank white paper while retaining white labels on a dark image', () => {
    const operations = list(
      [ops.setFont, ['embedded', 8]],
      [ops.setFillRGBColor, ['#ffffff']],
      [ops.showText, [[]]],
    );
    const pixels = raster();
    for (let y = 50; y < 65; y++)
      for (let x = 50; x < 65; x++) {
        const offset = (y * 100 + x) * 4;
        pixels.pixels[offset] = pixels.pixels[offset + 1] = pixels.pixels[offset + 2] = 20;
      }
    const result = visibleTextItems(
      [item('invisible-code', 10, 10), item('visible-on-dark', 52, 52)],
      operations,
      ops,
      identity,
      page,
      pixels,
    );
    expect(result.map((entry) => entry.id)).toEqual(['visible-on-dark']);
    expect(result[0].preserve).toBe(true);
  });

  it('does not reflow text rendered only in invisible text mode', () => {
    const operations = list(
      [ops.setFont, ['embedded', 8]],
      [ops.setTextRenderingMode, [3]],
      [ops.showText, [[]]],
    );
    expect(
      visibleTextItems([item('hidden', 30, 30)], operations, ops, identity, page, raster()),
    ).toEqual([]);
  });

  it('applies the viewport, nested matrices and transparency clip only once', () => {
    const matrix = [1, 0, 0, 1, 10, 20];
    const operations = list(
      [ops.beginGroup, [{ matrix, bbox: [0, 0, 40, 30] }]],
      [ops.paintFormXObjectBegin, [matrix, null]],
      [ops.setFont, ['embedded', 8]],
      [ops.showText, [[]]],
      [ops.paintFormXObjectEnd, []],
      [ops.endGroup, []],
    );
    const result = visibleTextItems(
      [item('inside', 25, 15), item('outside', 65, 65)],
      operations,
      ops,
      [0, 1, 1, 0, 0, 0],
      page,
      raster(),
    );
    expect(result.map((entry) => entry.id)).toEqual(['inside']);
  });
});
