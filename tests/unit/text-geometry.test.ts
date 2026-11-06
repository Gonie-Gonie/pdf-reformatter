import { describe, expect, it } from 'vitest';
import { textGeometry } from '../../src/adapters/pdf/text-geometry';

describe('source text geometry', () => {
  it.each([
    [NaN, NaN],
    [Infinity, -0.2],
    [0.8, -Infinity],
    [0, 0],
    [-0.2, 0.8],
  ])('uses baseline-relative fallback for unusable font metrics %s/%s', (ascent, descent) => {
    const measured = textGeometry([9, 0, 0, -9, 299.25, 742], 13.5, 9, ascent, descent);
    expect(measured.rect.x).toBeCloseTo(299.25);
    expect(measured.rect.y).toBeCloseTo(734.35);
    expect(measured.rect.width).toBeCloseTo(13.5);
    expect(measured.rect.height).toBeCloseTo(9.45);
    expect(measured.preserve).toBe(false);
  });

  it('normalizes missing metrics before measuring a rotated margin label', () => {
    const measured = textGeometry([0, -20, -20, 0, 32, 555], 341.08, 20, NaN, NaN);
    expect(measured.rect.x).toBeCloseTo(15);
    expect(measured.rect.y).toBeCloseTo(213.92);
    expect(measured.rect.width).toBeCloseTo(21);
    expect(measured.rect.height).toBeCloseTo(341.08);
    expect(measured.rotation).toBeCloseTo(-90);
    expect(measured.preserve).toBe(true);
  });

  it('keeps zero-span monospace metrics from placing the glyph mask below its baseline', () => {
    const measured = textGeometry([10, 0, 0, -10, 149, 643.615], 196, 10, 0, 0);
    expect(measured.rect.y).toBeCloseTo(635.115);
    expect(measured.rect.y + measured.rect.height).toBeCloseTo(645.615);
  });

  it.each([
    [2.4, -1.3],
    [0, -0.8],
    [-0.1, -0.8],
  ])('retains valid unusual font metrics %s/%s', (ascent, descent) => {
    const measured = textGeometry([10, 0, 0, -10, 33, 80], 120, 10, ascent, descent);
    expect(measured.rect.y).toBeCloseTo(80 - ascent * 10);
    expect(measured.rect.height).toBeCloseTo((ascent - Math.min(descent, ascent - 1)) * 10);
  });

  it('keeps ordinary text in the top-left page coordinate system', () => {
    const measured = textGeometry([10, 0, 0, -10, 33, 80], 120, 10, 0.8, -0.2);
    expect(measured.rect).toEqual({ x: 33, y: 72, width: 120, height: 10 });
    expect(measured.preserve).toBe(false);
  });
  it('bounds a vertical dimension label without flagging its entire page', () => {
    const measured = textGeometry([0, -8, -8, 0, 100, 280], 16, 8, 0.8, -0.2);
    expect(measured.rotation).toBe(-90);
    expect(measured.preserve).toBe(true);
    expect(measured.rect.x).toBeCloseTo(93.6);
    expect(measured.rect.y).toBe(264);
    expect(measured.rect.width).toBeCloseTo(8);
    expect(measured.rect.height).toBe(16);
  });
  it('includes the complete advance and ascent at an arbitrary angle', () => {
    const unit = Math.SQRT1_2;
    const measured = textGeometry(
      [10 * unit, 10 * unit, 10 * unit, -10 * unit, 100, 100],
      40,
      10,
      0.8,
      -0.2,
    );
    expect(measured.rotation).toBeCloseTo(45);
    expect(measured.rect.width).toBeCloseTo(50 * unit);
    expect(measured.rect.height).toBeCloseTo(50 * unit);
    expect(measured.preserve).toBe(true);
  });
});
