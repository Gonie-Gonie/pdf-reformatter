import { describe, expect, it } from 'vitest';
import {
  closePreservationRegions,
  ownsPreservedText,
  preservedRasterRect,
} from '../../src/core/preservation';
import type { Rect, SourceText } from '../../src/core/model';

function text(id: string, x: number, y: number, width = 245, height = 13.04): SourceText {
  return {
    id,
    text: 'An ordinary paragraph line.',
    x,
    y,
    width,
    height,
    fontSize: 9.95,
    fontName: 'serif',
    hasEOL: true,
  };
}

function seed(rect: Rect, reason = '수식 또는 첨자가 포함된 줄을 원문 모양으로 보존') {
  return { rect, reason };
}

describe('local preservation ownership', () => {
  it('does not expand a preserved line through dense neighboring font boxes', () => {
    const items = Array.from({ length: 20 }, (_, index) =>
      text(`line-${index}`, 36, 50 + index * 10.49),
    );
    const line = items[7];
    const input = seed({
      x: line.x - 2,
      y: line.y - 2,
      width: line.width + 4,
      height: line.height + 4,
    });
    const regions = closePreservationRegions({ width: 595, height: 794, items }, [input]);
    expect(regions).toHaveLength(1);
    expect(regions[0].reason).toBe(input.reason);
    for (const key of ['x', 'y', 'width', 'height'] as const)
      expect(regions[0].rect[key]).toBeCloseTo(input.rect[key], 8);
    expect(
      items.filter((item) => ownsPreservedText(regions[0].rect, item)).map((item) => item.id),
    ).toEqual(['line-7']);
  });

  it('keeps adjacent preserved lines separate when only their padding overlaps', () => {
    const items = [text('a', 36, 100), text('b', 36, 110.49)];
    const seeds = items.map((item) =>
      seed({ x: item.x - 2, y: item.y - 2, width: item.width + 4, height: item.height + 4 }),
    );
    const regions = closePreservationRegions({ width: 595, height: 794, items }, seeds);
    expect(regions).toHaveLength(2);
    expect(
      regions.map((region) =>
        items.filter((item) => ownsPreservedText(region.rect, item)).map((item) => item.id),
      ),
    ).toEqual([['a'], ['b']]);
  });

  it('expands a genuinely intersecting text fragment to preserve the whole source item', () => {
    const label = text('label', 100, 100, 70, 12);
    const regions = closePreservationRegions({ width: 595, height: 794, items: [label] }, [
      seed({ x: 40, y: 98, width: 90, height: 18 }),
    ]);
    expect(regions[0].rect).toEqual({ x: 40, y: 98, width: 130, height: 18 });
    expect(ownsPreservedText(regions[0].rect, label)).toBe(true);
  });

  it('does not absorb a parallel line across a narrow column gutter', () => {
    const items = [text('left', 36, 100), text('right', 301, 100)];
    const regions = closePreservationRegions({ width: 595, height: 794, items }, [
      seed({ x: 34, y: 98, width: 249, height: 17.04 }),
    ]);
    expect(
      items.filter((item) => ownsPreservedText(regions[0].rect, item)).map((item) => item.id),
    ).toEqual(['left']);
  });

  it('does not let a thin separator rule claim a nearby prose line', () => {
    expect(ownsPreservedText({ x: 30, y: 111, width: 250, height: 3 }, text('body', 36, 100))).toBe(
      false,
    );
  });

  it('keeps zero-advance combining marks inside their preserved mathematical object', () => {
    const base = text('base', 40, 100, 30, 10);
    const accent = { ...text('accent', 55, 99, 0, 8), text: '\u0302' };
    const divider = { ...text('divider', 70, 101, 0, 8), text: '\u20d2' };
    const outside = { ...accent, id: 'outside', x: 75 };
    const regions = closePreservationRegions(
      { width: 200, height: 200, items: [base, accent, divider, outside] },
      [seed({ x: 38, y: 97, width: 34, height: 15 })],
    );
    expect([base, accent, divider].every((item) => ownsPreservedText(regions[0].rect, item))).toBe(
      true,
    );
    expect(ownsPreservedText(regions[0].rect, outside)).toBe(false);
  });

  it('merges overlapping diagram regions and keeps a shared label owned once', () => {
    const label = text('label', 85, 110, 40, 10);
    const regions = closePreservationRegions({ width: 595, height: 794, items: [label] }, [
      seed({ x: 40, y: 95, width: 65, height: 45 }, '그림'),
      seed({ x: 95, y: 100, width: 80, height: 50 }, '회전 문자'),
    ]);
    expect(regions).toHaveLength(1);
    expect(regions[0].rect).toEqual({ x: 40, y: 95, width: 135, height: 55 });
    expect(ownsPreservedText(regions[0].rect, label)).toBe(true);
  });

  it('includes a compact dimension label partly crossing the bottom of a figure', () => {
    const label = {
      ...text('dimension', 217.2576, 300.6244, 15.368, 8),
      text: '56 m',
      fontSize: 8,
    };
    const caption = {
      ...text('caption', 95, 319, 190, 8),
      text: 'Figure 2.1. The building dimensions.',
    };
    const prose = {
      ...text('prose', 95, 300.6244, 180, 8),
      text: 'The building measures 56 m in length.',
    };
    const input = seed(
      { x: 91, y: 218, width: 257, height: 86 },
      '그림·표·벡터 도형을 원문 모양으로 보존',
    );
    const regions = closePreservationRegions({ width: 432, height: 648, items: [label, caption] }, [
      input,
    ]);
    expect(ownsPreservedText(regions[0].rect, label)).toBe(true);
    expect(ownsPreservedText(regions[0].rect, caption)).toBe(false);
    expect(regions[0].rect.y + regions[0].rect.height).toBeCloseTo(308.6244);
    const withProse = closePreservationRegions({ width: 432, height: 648, items: [prose] }, [
      input,
    ]);
    expect(withProse).toEqual([input]);
    expect(ownsPreservedText(withProse[0].rect, prose)).toBe(false);
  });

  it('does not grow figure bounds through unrelated numeric text or caption labels', () => {
    const labeledCaption = {
      ...text('caption-label', 100, 300.6244, 15, 8),
      text: '56 m',
      structureRoles: ['Caption'],
    };
    const beyond = { ...text('beyond', 100, 310, 15, 8), text: '57 m' };
    const input = seed(
      { x: 91, y: 218, width: 257, height: 86 },
      '그림·표·벡터 도형을 원문 모양으로 보존',
    );
    expect(
      closePreservationRegions({ width: 432, height: 648, items: [labeledCaption, beyond] }, [
        input,
      ]),
    ).toEqual([input]);
    const math = seed(input.rect);
    expect(
      closePreservationRegions(
        { width: 432, height: 648, items: [{ ...labeledCaption, structureRoles: [] }] },
        [math],
      ),
    ).toEqual([math]);
  });

  it('does not mutate seed rectangles while clamping preserved regions to the page', () => {
    const input = seed({ x: -2, y: -3, width: 20, height: 20 });
    const regions = closePreservationRegions({ width: 100, height: 100, items: [] }, [input]);
    expect(input.rect).toEqual({ x: -2, y: -3, width: 20, height: 20 });
    expect(regions[0].rect).toEqual({ x: 0, y: 0, width: 18, height: 17 });
  });
});

describe('inline preserved raster boundaries', () => {
  const before = text('before', 37.588, 323.9307, 251.11, 13.037);
  const body = text('body', 37.588, 334.3619, 21.656, 13.037);
  const exponent = { ...text('exponent', 59.244, 333.2327, 3.3449, 9.7783), fontSize: 5.9779 };
  const rest = text('rest', 62.5889, 334.3655, 226.083, 13.037);
  const after = text('after', 37.588, 344.8533, 251.094, 13.037);
  const owned = [body, exponent, rest];
  const page = { items: [before, ...owned, after], graphicRegions: [] };
  const region = seed({ x: 35.588, y: 331.2327, width: 255.084, height: 18.1698 });

  it('trims neighboring rows while keeping a raised exponent in the raster', () => {
    const crop = preservedRasterRect(page, region, owned);
    expect(crop).toEqual({ x: 35.588, y: 335, width: 255.084, height: 11 });
    expect(owned.every((item) => ownsPreservedText(crop, item))).toBe(true);
    expect(ownsPreservedText(crop, before)).toBe(false);
    expect(ownsPreservedText(crop, after)).toBe(false);
    expect(region.rect.y).toBe(331.2327);
  });

  it('does not use neighboring rows from the other column as crop boundaries', () => {
    const otherColumn = {
      items: [...owned, { ...before, x: 305 }, { ...after, x: 305 }],
      graphicRegions: [],
    };
    expect(preservedRasterRect(otherColumn, region, owned)).toBe(region.rect);
  });

  it('leaves display equations and graphic-containing regions unchanged', () => {
    expect(preservedRasterRect(page, { ...region, displayMath: true }, owned)).toBe(region.rect);
    expect(
      preservedRasterRect(
        { ...page, graphicRegions: [{ x: 50, y: 336, width: 30, height: 2 }] },
        region,
        owned,
      ),
    ).toBe(region.rect);
    expect(
      preservedRasterRect(page, seed(region.rect, '그림·표·벡터 도형을 원문 모양으로 보존'), owned),
    ).toBe(region.rect);
  });

  it('leaves rotated labels and multiline mathematical objects unchanged', () => {
    expect(preservedRasterRect(page, region, [{ ...body, preserve: true }])).toBe(region.rect);
    expect(preservedRasterRect(page, region, [{ ...body, rotation: 90 }])).toBe(region.rect);
    expect(preservedRasterRect(page, region, [body, after])).toBe(region.rect);
  });

  it('leaves a large or uncertain crop unchanged instead of removing substantial content', () => {
    const oversized = seed({ x: 35.588, y: 310, width: 255.084, height: 60 });
    expect(preservedRasterRect(page, oversized, owned)).toBe(oversized.rect);
    expect(preservedRasterRect(page, region, [])).toBe(region.rect);
  });
});
