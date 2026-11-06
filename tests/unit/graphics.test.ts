import { describe, expect, it } from 'vitest';
import {
  detectGraphicRegions,
  drawingTextIds,
  mergeGraphicRegions,
} from '../../src/adapters/pdf/graphics';
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
  it('does not let a running header rule bridge two independent plots', () => {
    const regions = [
      { x: 49, y: 46, width: 497, height: 6 },
      { x: 100, y: 58, width: 190, height: 118 },
      { x: 347, y: 58, width: 193, height: 118 },
    ];
    const source = page([
      text('folio', { x: 50, y: 30, width: 15, height: 10 }, '192'),
      text('header', { x: 310, y: 30, width: 230, height: 10 }, 'Linear Regression Analysis'),
    ]);
    expect(mergeGraphicRegions(regions, source)).toEqual(regions);
    // A real plot border without running-header proof remains connected to its axes.
    expect(mergeGraphicRegions(regions, page())).toEqual([
      { x: 49, y: 46, width: 497, height: 130 },
    ]);
  });

  it('removes a colored example margin rule without erasing its diagram or ordinary colored frames', () => {
    const width = 300;
    const height = 400;
    const paint = (pixels: Uint8ClampedArray, rect: Rect) => {
      for (let y = rect.y; y < rect.y + rect.height; y++)
        for (let x = rect.x; x < rect.x + rect.width; x++) {
          const index = (y * width + x) * 4;
          pixels[index] = 230;
          pixels[index + 1] = 20;
          pixels[index + 2] = 20;
        }
    };
    const body = Array.from({ length: 5 }, (_, index) =>
      text(`prose-${index}`, { x: 54, y: 40 + index * 25, width: 200, height: 10 }),
    );
    const frame = { x: 50, y: 20, width: 1, height: 340 };
    const diagram = { x: 90, y: 190, width: 150, height: 70 };
    const pixels = raster(width, height, [diagram]);
    paint(pixels, frame);
    expect(detectGraphicRegions(pixels, width, height, 1, page(body, width, height))).toEqual([
      { x: 88, y: 188, width: 154, height: 74 },
    ]);

    const chart = raster(width, height, [diagram]);
    paint(chart, frame);
    expect(detectGraphicRegions(chart, width, height, 1, page([], width, height))).toContainEqual({
      x: 48,
      y: 18,
      width: 5,
      height: 344,
    });

    const table = raster(width, height, []);
    paint(table, frame);
    paint(table, { x: 50, y: 20, width: 220, height: 1 });
    paint(table, { x: 50, y: 359, width: 220, height: 1 });
    expect(detectGraphicRegions(table, width, height, 1, page(body, width, height))).toContainEqual(
      {
        x: 48,
        y: 18,
        width: 224,
        height: 344,
      },
    );
  });

  it('recognizes repeated enlarged point glyphs as drawing ink without changing ordinary ellipses', () => {
    const body = text('body', { x: 50, y: 600, width: 400, height: 10 });
    const points = Array.from({ length: 8 }, (_, index) => ({
      ...text(
        `point-${index}`,
        { x: 100 + index * 20, y: 100 + (index % 3) * 30, width: 12, height: 43 },
        '.',
      ),
      fontSize: 43,
    }));
    const ordinary = text('ellipsis', { x: 50, y: 620, width: 15, height: 10 }, '...');
    expect(drawingTextIds(page([body, ...points, ordinary]))).toEqual(
      new Set(points.map((item) => item.id)),
    );
    expect(drawingTextIds(page([body, points[0], ordinary])).size).toBe(0);
  });

  it('keeps neighboring plots separate when each has its own chapter-numbered caption', () => {
    const plots = [
      { x: 50, y: 50, width: 210, height: 100 },
      { x: 270, y: 50, width: 210, height: 100 },
    ];
    const captions = [
      text('left', { x: 50, y: 160, width: 210, height: 10 }, 'Fig. 5.15 A separate left plot.'),
      text('right', { x: 270, y: 160, width: 210, height: 10 }, 'Fig. 5.18 A separate right plot.'),
    ];
    expect(mergeGraphicRegions(plots, page(captions))).toEqual(plots);
    expect(
      mergeGraphicRegions(
        plots,
        page([
          text('shared', { x: 50, y: 160, width: 430, height: 10 }, 'Fig. 5.15 Shared panels.'),
        ]),
      ),
    ).toEqual([{ x: 50, y: 50, width: 430, height: 100 }]);
  });

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

  it('does not mask illustration ink behind a preserved overlapping text run', () => {
    const picture = { x: 25, y: 40, width: 50, height: 25 };
    const preserved = {
      ...text('preserved', picture, 'White text over an actual colored illustration'),
      preserve: true,
    };
    expect(
      detectGraphicRegions(raster(100, 100, [picture]), 100, 100, 1, page([preserved], 100, 100)),
    ).toEqual([{ x: 23, y: 38, width: 54, height: 29 }]);
  });

  it('masks the full body ink of prose merged into a small superscript run without hiding nearby artwork', () => {
    const neighbor = {
      ...text('body', { x: 30, y: 44, width: 10, height: 10 }, 'an'),
      baselineY: 51.2,
    };
    const mixed = {
      ...text(
        'mixed',
        { x: 50, y: 47, width: 120, height: 7.6 },
        '2 value of 91%, offering a robust understanding',
      ),
      fontSize: 7.6,
      baselineY: 52.7,
    };
    const source = page([neighbor, mixed], 200, 100);
    const bodyInk = { x: 60, y: 44, width: 100, height: 10 };
    expect(detectGraphicRegions(raster(200, 100, [bodyInk]), 200, 100, 1, source)).toEqual([]);
    const artwork = { x: 60, y: 30, width: 70, height: 8 };
    expect(detectGraphicRegions(raster(200, 100, [bodyInk, artwork]), 200, 100, 1, source)).toEqual(
      [{ x: 58, y: 28, width: 74, height: 12 }],
    );
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

  it('does not join tiny running artwork to a nearby full-width illustration', () => {
    const logo = { x: 260, y: 28, width: 12, height: 12 };
    const illustration = { x: 50, y: 53, width: 500, height: 130 };
    const source = page([
      text(
        'running-title',
        { x: 50, y: 30, width: 200, height: 10 },
        'JOURNAL OF BUILDING PERFORMANCE',
      ),
      text('folio', { x: 550, y: 30, width: 15, height: 10 }, '687'),
    ]);
    expect(mergeGraphicRegions([logo, illustration], source)).toEqual([logo, illustration]);
  });

  it('does not grow a running logo into a figure through a small intermediate ink fragment', () => {
    const logo = { x: 260, y: 28, width: 12, height: 12 };
    const corner = { x: 260, y: 53, width: 15, height: 20 };
    const illustration = { x: 50, y: 75, width: 500, height: 130 };
    const source = page([
      text(
        'running-title',
        { x: 50, y: 30, width: 200, height: 10 },
        'JOURNAL OF BUILDING PERFORMANCE',
      ),
      text('folio', { x: 550, y: 30, width: 15, height: 10 }, '687'),
    ]);
    expect(mergeGraphicRegions([logo, corner, illustration], source)).toEqual([
      logo,
      { x: 50, y: 53, width: 500, height: 152 },
    ]);
  });

  it('does not mistake an ordinary compact chart symbol for running artwork without folio evidence', () => {
    const symbol = { x: 260, y: 28, width: 12, height: 12 };
    const illustration = { x: 50, y: 53, width: 500, height: 130 };
    const source = page([
      text('chart-title', { x: 50, y: 30, width: 200, height: 10 }, 'Annual demand comparison'),
    ]);
    expect(mergeGraphicRegions([symbol, illustration], source)).toEqual([
      { x: 50, y: 28, width: 500, height: 155 },
    ]);
  });

  it('retains thin visible rules and maps the sample raster back to PDF coordinates', () => {
    const pixels = raster(120, 160, [{ x: 10, y: 20, width: 80, height: 1 }]);
    expect(detectGraphicRegions(pixels, 120, 160, 0.5, page([], 240, 320))).toEqual([
      { x: 18, y: 38, width: 164, height: 6 },
    ]);
  });
});
