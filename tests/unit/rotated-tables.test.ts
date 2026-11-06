import { describe, expect, it } from 'vitest';
import { rotatedTableRegions } from '../../src/core/rotated-tables';
import type { Rect, SourcePage, SourceText } from '../../src/core/model';

function fixture(rotation = -90, continued = false): SourcePage {
  const width = 600,
    height = 800;
  const physical = (rect: Rect): Rect =>
    rotation < 0
      ? { x: rect.y, y: height - rect.x - rect.width, width: rect.height, height: rect.width }
      : { x: width - rect.y - rect.height, y: rect.x, width: rect.height, height: rect.width };
  const item = (id: string, text: string, rect: Rect, fontSize = 8): SourceText => ({
    id,
    text,
    ...physical(rect),
    fontSize,
    fontName: 'serif',
    hasEOL: true,
    preserve: true,
    rotation,
  });
  return {
    number: 5,
    width,
    height,
    rotation: 0,
    warnings: [],
    items: [
      item(
        'caption',
        continued ? 'TABLE 1: Continued.' : 'TABLE 1: Comparison of the reviewed studies.',
        { x: 180, y: 80, width: 380, height: 9 },
        9,
      ),
      ...Array.from({ length: 6 }, (_, row) =>
        Array.from({ length: 5 }, (_, column) =>
          item(`r${row}c${column}`, `Cell ${row} ${column}`, {
            x: 65 + column * 130,
            y: 115 + row * 40,
            width: 100,
            height: 8,
          }),
        ),
      ).flat(),
      {
        id: 'watermark',
        text: 'Downloaded from the publisher library; use is governed by the applicable Creative Commons license.',
        x: 584,
        y: 17,
        width: 5,
        height: 766,
        fontSize: 4.8,
        fontName: 'serif',
        hasEOL: false,
        preserve: true,
        rotation: -rotation,
      },
    ],
    graphicRegions: [100, 130, 340].map((y) => physical({ x: 60, y, width: 680, height: 1 })),
  };
}

describe('sideways tables', () => {
  it.each([-90, 90])('keeps caption, rules and every cell together at %s degrees', (rotation) => {
    const page = fixture(rotation);
    const regions = rotatedTableRegions(page);
    expect(regions).toHaveLength(1);
    const rect = regions[0].rect;
    for (const item of page.items.filter((item) => item.id !== 'watermark')) {
      expect(rect.x).toBeLessThanOrEqual(item.x);
      expect(rect.y).toBeLessThanOrEqual(item.y);
      expect(rect.x + rect.width).toBeGreaterThanOrEqual(item.x + item.width);
      expect(rect.y + rect.height).toBeGreaterThanOrEqual(item.y + item.height);
    }
    expect(rect.x + rect.width).toBeLessThan(584);
  });

  it('recognizes a continued table without requiring a repeated long title', () => {
    expect(rotatedTableRegions(fixture(-90, true))).toHaveLength(1);
  });

  it('requires both parallel rules and a repeated cell grid', () => {
    const page = fixture();
    expect(rotatedTableRegions({ ...page, graphicRegions: [] })).toEqual([]);
    expect(rotatedTableRegions({ ...page, items: page.items.slice(0, 8) })).toEqual([]);
  });

  it('leaves an ordinary rotated axis alone', () => {
    const page = fixture();
    page.items = page.items.map((item) =>
      item.id === 'caption' ? { ...item, text: 'Annual energy demand (kWh)' } : item,
    );
    expect(rotatedTableRegions(page)).toEqual([]);
  });

  it('does not absorb an ordinary horizontal paragraph next to rotated labels', () => {
    const page = fixture();
    page.items.push({
      id: 'body',
      text: 'An ordinary horizontal paragraph stays outside preservation.',
      x: 180,
      y: 300,
      width: 100,
      height: 10,
      fontSize: 10,
      fontName: 'serif',
      hasEOL: true,
    });
    expect(rotatedTableRegions(page)).toEqual([]);
  });
});
