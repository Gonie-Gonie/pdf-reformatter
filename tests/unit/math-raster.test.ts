import { describe, expect, it } from 'vitest';
import { recolorMathPixels, recolorPreservedTextPixels } from '../../src/adapters/pdf/math-raster';

describe('formula ink', () => {
  const image = (middle: number[]) =>
    new Uint8ClampedArray([
      255,
      255,
      255,
      255,
      255,
      255,
      255,
      255,
      255,
      255,
      255,
      255,
      255,
      255,
      255,
      255,
      ...middle,
      255,
      255,
      255,
      255,
      255,
      255,
      255,
      255,
      255,
      255,
      255,
      255,
      255,
      255,
      255,
      255,
    ]);

  it('makes white transparent and keeps antialiasing in the selected ink', () => {
    const pixels = image([128, 128, 128, 255]);
    expect(recolorMathPixels(pixels, 3, 3, '#604020')).toBe(true);
    expect([...pixels.slice(0, 4)]).toEqual([96, 64, 32, 0]);
    expect([...pixels.slice(16, 20)]).toEqual([96, 64, 32, 127]);
  });

  it('preserves colored annotations without partial mutation', () => {
    const pixels = image([255, 10, 10, 255]);
    const original = pixels.slice();
    expect(recolorMathPixels(pixels, 3, 3, '#604020')).toBe(false);
    expect(pixels).toEqual(original);
  });

  it('preserves a crop with a nonwhite background', () => {
    const pixels = image([0, 0, 0, 255]);
    pixels[0] = 0;
    const original = pixels.slice();
    expect(recolorMathPixels(pixels, 3, 3, '#604020')).toBe(false);
    expect(pixels).toEqual(original);
  });
});

describe('preserved TOC and index text ink', () => {
  const image = (width: number, height: number, pixel: (x: number, y: number) => number[]) =>
    new Uint8ClampedArray(
      Array.from({ length: width * height }, (_, index) =>
        pixel(index % width, Math.floor(index / width)),
      ).flat(),
    );
  const white = [255, 255, 255, 255];
  const black = [0, 0, 0, 255];

  it.each(['#41342b', '#e9e6df'])(
    'removes white rectangles behind tight text and dot leaders in ink %s',
    (foreground) => {
      const pixels = image(20, 8, (x, y) =>
        (x === 0 && y === 0) || (y === 4 && x % 2 === 0) || (x === 19 && y === 7) ? black : white,
      );
      expect(recolorMathPixels(pixels.slice(), 20, 8, foreground)).toBe(false);
      expect(recolorPreservedTextPixels(pixels, 20, 8, foreground)).toBe(true);
      const rgb = [1, 3, 5].map((offset) =>
        Number.parseInt(foreground.slice(offset, offset + 2), 16),
      );
      expect([...pixels.slice(0, 4)]).toEqual([...rgb, 255]);
      expect([...pixels.slice(4, 8)]).toEqual([...rgb, 0]);
      expect([...pixels.slice(-4)]).toEqual([...rgb, 255]);
      // The white part now exposes the page color instead of an opaque patch.
      const background = [246, 240, 227];
      expect(
        background.map((value, channel) =>
          Math.round((pixels[4 + channel] * pixels[7]) / 255 + value * (1 - pixels[7] / 255)),
        ),
      ).toEqual(background);
    },
  );

  it('retains antialiasing and existing alpha while changing only the ink color', () => {
    const pixels = image(10, 10, (x, y) =>
      x === 2 && y === 3 ? [128, 128, 128, 128] : x === 2 && y === 4 ? black : white,
    );
    expect(recolorPreservedTextPixels(pixels, 10, 10, '#604020')).toBe(true);
    const offset = (3 * 10 + 2) * 4;
    expect([...pixels.slice(offset, offset + 4)]).toEqual([96, 64, 32, 64]);
  });

  it('does not partially recolor a crop containing colored artwork or a link', () => {
    const pixels = image(10, 10, (x, y) =>
      x === 2 && y === 2 ? black : x === 8 && y === 8 ? [30, 50, 180, 255] : white,
    );
    const original = pixels.slice();
    expect(recolorPreservedTextPixels(pixels, 10, 10, '#41342b')).toBe(false);
    expect(pixels).toEqual(original);
  });

  it.each(['#41342b', '#e9e6df'])(
    'keeps sparse colored chapter accents while removing their white matte in ink %s',
    (foreground) => {
      const pixels = image(20, 10, (x, y) =>
        x < 5 && y < 5
          ? black
          : x === 19 && y === 0
            ? [255, 0, 0, 255]
            : x === 19 && y === 1
              ? [255, 128, 128, 255]
              : white,
      );
      expect(recolorPreservedTextPixels(pixels, 20, 10, foreground)).toBe(true);
      expect([...pixels.slice(19 * 4, 20 * 4)]).toEqual([255, 0, 0, 255]);
      const edge = (20 + 19) * 4;
      expect([...pixels.slice(edge, edge + 4)]).toEqual([255, 0, 0, 127]);
      expect([...pixels.slice(-4)]).toEqual([
        ...[1, 3, 5].map((offset) => Number.parseInt(foreground.slice(offset, offset + 2), 16)),
        0,
      ]);
    },
  );

  it('preserves a broad colored panel even with dark lettering and white margins', () => {
    const pixels = image(20, 10, (x, y) =>
      y === 0 ? black : x < 10 ? white : [180, 210, 245, 255],
    );
    const original = pixels.slice();
    expect(recolorPreservedTextPixels(pixels, 20, 10, '#41342b')).toBe(false);
    expect(pixels).toEqual(original);
  });

  it('keeps a thin colored chapter rule even when it outnumbers the letters', () => {
    const pixels = image(40, 10, (x, y) =>
      y === 8 ? [255, 0, 0, 255] : x < 3 && y < 3 ? black : white,
    );
    expect(recolorPreservedTextPixels(pixels, 40, 10, '#41342b')).toBe(true);
    const rule = 8 * 40 * 4;
    expect([...pixels.slice(rule, rule + 4)]).toEqual([255, 0, 0, 255]);
    expect([...pixels.slice(-4)]).toEqual([65, 52, 43, 0]);
  });

  it('keeps gray panels and grayscale image tones intact', () => {
    for (const pixels of [
      image(10, 10, (x, y) => (x === 2 && y === 2 ? black : [220, 220, 220, 255])),
      image(10, 10, (_x, y) => (y < 6 ? white : y === 6 ? black : [190, 190, 190, 255])),
    ]) {
      const original = pixels.slice();
      expect(recolorPreservedTextPixels(pixels, 10, 10, '#41342b')).toBe(false);
      expect(pixels).toEqual(original);
    }
  });

  it('rejects invalid geometry, ink colors, and empty transparent crops without mutation', () => {
    const pixels = image(10, 10, (x, y) => (x === 2 && y === 2 ? black : white));
    const original = pixels.slice();
    expect(recolorPreservedTextPixels(pixels, 0, 10, '#41342b')).toBe(false);
    expect(recolorPreservedTextPixels(pixels, 10, 9, '#41342b')).toBe(false);
    expect(recolorPreservedTextPixels(pixels, 10, 10, '#gggggg')).toBe(false);
    expect(pixels).toEqual(original);
    expect(recolorPreservedTextPixels(new Uint8ClampedArray(400), 10, 10, '#41342b')).toBe(false);
  });
});
