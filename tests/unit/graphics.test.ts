import { describe, expect, it } from 'vitest';
import { detectGraphicRegions, mergeGraphicRegions } from '../../src/adapters/pdf/graphics';
import type { Rect, SourcePage, SourceText } from '../../src/core/model';

function page(items: SourceText[] = [], width = 600, height = 800): SourcePage {
  return { number: 1, width, height, rotation: 0, items, graphicRegions: [], warnings: [] };
}

function text(
  id: string,
  rect: Rect,
  value = 'A paragraph or figure caption stays in flowing text.',
): SourceText {
  return { id, ...rect, text: value, fontSize: 10, fontName: 'serif', hasEOL: true };
}

function raster(width: number, height: number, shapes: Rect[]): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
  for (const shape of shapes) {
    for (let y = shape.y; y < shape.y + shape.height; y++) {
      for (let x = shape.x; x < shape.x + shape.width; x++) {
        const index = (y * width + x) * 4;
        pixels[index] = pixels[index + 1] = pixels[index + 2] = 0;
      }
    }
  }
  return pixels;
}

describe('figure region detection', () => {
  it('uses actual ink bounds rather than extending an image to coarse cell boundaries', () => {
    const pixels = raster(100, 100, [{ x: 21, y: 37, width: 18, height: 15 }]);
    expect(detectGraphicRegions(pixels, 100, 100, 1, page([], 100, 100))).toEqual([
      { x: 19, y: 35, width: 22, height: 19 },
    ]);
  });

  it('masks flowing text and keeps only the nearby illustration', () => {
    const paragraph = { x: 10, y: 10, width: 80, height: 9 };
    const picture = { x: 25, y: 40, width: 50, height: 25 };
    const source = page([text('body', paragraph)], 100, 100);
    const regions = detectGraphicRegions(
      raster(100, 100, [paragraph, picture]),
      100,
      100,
      1,
      source,
    );
    expect(regions).toEqual([{ x: 23, y: 38, width: 54, height: 29 }]);
  });

  it('does not merge separate drawings across an intervening caption', () => {
    const upper = { x: 50, y: 100, width: 200, height: 30 };
    const lower = { x: 50, y: 142, width: 200, height: 30 };
    const caption = text('caption', { x: 48, y: 131, width: 480, height: 10 });
    expect(mergeGraphicRegions([upper, lower], page([caption]))).toEqual([upper, lower]);
  });

  it('still joins nearby parts and short labels belonging to the same diagram', () => {
    const source = page([text('label', { x: 142, y: 110, width: 35, height: 10 }, '14 m')]);
    expect(
      mergeGraphicRegions(
        [
          { x: 40, y: 100, width: 100, height: 50 },
          { x: 150, y: 110, width: 60, height: 30 },
        ],
        source,
      ),
    ).toEqual([{ x: 40, y: 100, width: 170, height: 50 }]);
  });

  it('retains thin visible rules and maps the sample raster back to PDF coordinates', () => {
    const pixels = raster(120, 160, [{ x: 10, y: 20, width: 80, height: 1 }]);
    expect(detectGraphicRegions(pixels, 120, 160, 0.5, page([], 240, 320))).toEqual([
      { x: 18, y: 38, width: 164, height: 6 },
    ]);
  });
});
