import { describe, expect, it } from 'vitest';
import { graphicObjectBounds, joinGraphicObjects } from '../../src/adapters/pdf/graphic-objects';
import type { Rect, SourcePage, SourceText } from '../../src/core/model';

const operators = {
  save: 1,
  restore: 2,
  transform: 3,
  paintFormXObjectBegin: 4,
  paintFormXObjectEnd: 5,
  beginGroup: 6,
  endGroup: 7,
  paintImageXObject: 8,
  paintInlineImageXObject: 9,
};
const identity = [1, 0, 0, 1, 0, 0];
const dimensions = { width: 600, height: 800 };
function list(...entries: [number, unknown[]][]) {
  return { fnArray: entries.map(([op]) => op), argsArray: entries.map(([, args]) => args) };
}
function page(items: SourceText[] = []): SourcePage {
  return { number: 1, ...dimensions, rotation: 0, items, graphicRegions: [], warnings: [] };
}
function text(id: string, value: string, x: number, y: number, width: number): SourceText {
  return {
    id,
    text: value,
    x,
    y,
    width,
    height: 10,
    fontSize: 8,
    fontName: 'serif',
    hasEOL: true,
  };
}

describe('original PDF graphic object bounds', () => {
  it('maps nested form matrices through a rotated and cropped viewport and restores siblings', () => {
    const operations = list(
      [operators.save, []],
      [operators.transform, [1, 0, 0, 1, 100, 200]],
      [
        operators.paintFormXObjectBegin,
        [new Float32Array([2, 0, 0, 3, 10, 20]), new Float32Array([0, 0, 40, 20])],
      ],
      [
        operators.paintFormXObjectBegin,
        [
          [1, 0, 0, 1, 5, 3],
          [0, 0, 10, 4],
        ],
      ],
      [operators.paintFormXObjectEnd, []],
      [operators.paintFormXObjectEnd, []],
      [operators.restore, []],
      [operators.paintFormXObjectBegin, [null, [20, 30, 60, 70]]],
      [operators.paintFormXObjectEnd, []],
    );
    const bounds = graphicObjectBounds(operations, operators, [0, 1, 1, 0, -10, -20], dimensions);
    expect(bounds).toEqual(
      expect.arrayContaining([
        { x: 210, y: 90, width: 60, height: 80 },
        { x: 219, y: 100, width: 12, height: 20 },
        { x: 20, y: 0, width: 40, height: 40 },
      ]),
    );
  });

  it('uses a transparency group BBox while applying its matrix only once', () => {
    const matrix = [1, 0, 0, 1, 100, 200];
    const operations = list(
      [operators.beginGroup, [{ matrix, bbox: [0, 0, 80, 60], isolated: true }]],
      [operators.paintFormXObjectBegin, [matrix, null]],
      [operators.paintFormXObjectEnd, []],
      [operators.endGroup, []],
    );
    expect(graphicObjectBounds(operations, operators, identity, dimensions)).toEqual([
      { x: 100, y: 200, width: 80, height: 60 },
    ]);
  });

  it('clips a nested form to its parent form and the visible page', () => {
    const operations = list(
      [operators.paintFormXObjectBegin, [null, [10, 20, 90, 100]]],
      [
        operators.paintFormXObjectBegin,
        [
          [1, 0, 0, 1, -20, -30],
          [0, 0, 200, 200],
        ],
      ],
      [operators.paintFormXObjectEnd, []],
      [operators.paintFormXObjectEnd, []],
      [operators.paintFormXObjectBegin, [null, [-50, -30, 20, 40]]],
      [operators.paintFormXObjectEnd, []],
    );
    const bounds = graphicObjectBounds(operations, operators, identity, dimensions);
    expect(bounds).toContainEqual({ x: 10, y: 20, width: 80, height: 80 });
    expect(bounds.every((rect) => rect.x >= 0 && rect.y >= 0)).toBe(true);
    expect(bounds).toContainEqual({ x: 0, y: 0, width: 20, height: 40 });
    expect(bounds).not.toContainEqual({ x: 0, y: 0, width: 180, height: 170 });
  });

  it.each([operators.paintImageXObject, operators.paintInlineImageXObject])(
    'maps an image painted by operator %s from its unit square',
    (operator) => {
      const operations = list(
        [operators.save, []],
        [operators.transform, [120, 0, 0, -80, 50, 200]],
        [operator, ['image', 2400, 1600]],
        [operators.restore, []],
      );
      expect(graphicObjectBounds(operations, operators, identity, dimensions)).toEqual([
        { x: 50, y: 120, width: 120, height: 80 },
      ]);
    },
  );
});

describe('grouping visible graphic fragments by original object', () => {
  it('keeps a vector chart, its separated data rows and outlined axes in one source crop', () => {
    const fragments: Rect[] = [
      { x: 348, y: 330, width: 185, height: 104 },
      { x: 317, y: 362, width: 8, height: 9 },
      { x: 308, y: 387, width: 17, height: 50 },
      { x: 363, y: 453, width: 155, height: 11 },
      { x: 317, y: 454, width: 8, height: 9 },
      { x: 359, y: 484, width: 163, height: 11 },
      { x: 317, y: 485, width: 8, height: 9 },
      { x: 361, y: 511, width: 46, height: 17 },
      { x: 472, y: 511, width: 49, height: 18 },
    ];
    const object = { x: 306, y: 318, width: 245, height: 212 };
    const unrelated = { x: 96, y: 577, width: 397, height: 142 };
    const source = page([
      text('caption', 'Fig. 3. Model rank by accuracy versus value.', 306, 534, 251),
    ]);
    expect(joinGraphicObjects([...fragments, unrelated], [object], source)).toEqual(
      expect.arrayContaining([object, unrelated]),
    );
    expect(joinGraphicObjects([...fragments, unrelated], [object], source)).toHaveLength(2);
  });

  it('keeps a detached legend with its plot without changing an independent neighboring figure', () => {
    const plot = { x: 139, y: 546, width: 227, height: 182 };
    const legend = { x: 386, y: 549, width: 67, height: 84 };
    const other = { x: 39, y: 265, width: 248, height: 207 };
    const object = { x: 139, y: 546, width: 314, height: 184 };
    const source = page([
      text('caption', 'Fig. 6. Annual regret against building demand.', 67, 733, 461),
    ]);
    expect(joinGraphicObjects([plot, legend, other], [object], source)).toEqual(
      expect.arrayContaining([object, other]),
    );
    expect(joinGraphicObjects([plot, legend, other], [object], source)).toHaveLength(2);
  });

  it('does not turn a full-page wrapper form into one preserved page', () => {
    const fragments = [
      { x: 60, y: 120, width: 160, height: 100 },
      { x: 350, y: 560, width: 170, height: 100 },
    ];
    expect(joinGraphicObjects(fragments, [{ x: 0, y: 0, ...dimensions }], page())).toEqual(
      fragments,
    );
  });

  it('leaves a single already connected drawing at its detected ink bounds', () => {
    const graphic = { x: 130, y: 140, width: 120, height: 80 };
    const sparseWrapper = { x: 100, y: 100, width: 260, height: 200 };
    expect(joinGraphicObjects([graphic], [sparseWrapper], page())).toEqual([graphic]);
  });

  it.each(['caption', 'body'] as const)('does not bridge intervening %s text', (kind) => {
    const fragments = [
      { x: 100, y: 100, width: 200, height: 60 },
      { x: 100, y: 200, width: 200, height: 60 },
    ];
    const source = page(
      kind === 'caption'
        ? [text('caption', 'Fig. 2. A separate experiment.', 100, 175, 200)]
        : [
            text(
              'body-1',
              'Several ordinary words form a paragraph between drawings',
              100,
              173,
              220,
            ),
            text(
              'body-2',
              'Another ordinary sentence continues the same body paragraph',
              100,
              184,
              220,
            ),
          ],
    );
    expect(
      joinGraphicObjects(fragments, [{ x: 90, y: 90, width: 240, height: 180 }], source),
    ).toEqual(fragments);
  });

  it('rejects an object boundary cutting across an unrelated ink region', () => {
    const fragments = [
      { x: 110, y: 110, width: 80, height: 80 },
      { x: 220, y: 110, width: 60, height: 80 },
      { x: 285, y: 150, width: 160, height: 30 },
    ];
    expect(
      joinGraphicObjects(fragments, [{ x: 100, y: 100, width: 200, height: 120 }], page()),
    ).toEqual(fragments);
  });

  it('recognizes intervening prose when its words are separate PDF text runs', () => {
    const fragments = [
      { x: 100, y: 100, width: 200, height: 60 },
      { x: 100, y: 210, width: 200, height: 60 },
    ];
    const items = [
      'Several ordinary words form a paragraph between drawings',
      'Another ordinary sentence continues the same body paragraph',
    ].flatMap((row, index) => {
      let x = 100;
      return row.split(' ').map((word, column) => {
        const width = word.length * 3.5;
        const item = text(`word-${index}-${column}`, word, x, 175 + index * 12, width);
        x += width + 3;
        return item;
      });
    });
    expect(
      joinGraphicObjects(fragments, [{ x: 90, y: 90, width: 300, height: 190 }], page(items)),
    ).toEqual(fragments);
  });
});
