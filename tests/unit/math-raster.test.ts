import { describe, expect, it } from 'vitest';
import { recolorMathPixels } from '../../src/adapters/pdf/math-raster';

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
