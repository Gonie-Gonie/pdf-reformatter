import { describe, expect, it } from 'vitest';
import { textGeometry } from '../../src/adapters/pdf/text-geometry';

describe('source text geometry', () => {
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
