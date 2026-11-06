import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/core/config';
import { buildPageLinks, regionRectToOutput, regionRectToSource } from '../../src/core/navigation';
import type {
  LayoutDocument,
  LayoutPage,
  ReadingBlock,
  ReadingDocument,
  Rect,
  RegionPlacement,
  SourceDocument,
  SourceText,
  TextPlacement,
} from '../../src/core/model';

function item(id: string, text: string, y: number): SourceText {
  return {
    id,
    text,
    x: 36,
    y,
    width: 300,
    height: 14,
    fontSize: 12,
    fontName: 'NotoSerif',
    hasEOL: true,
  };
}

function source(pages: SourceText[][]): SourceDocument {
  return {
    schemaVersion: 1,
    hash: 'source-hash',
    name: 'document.pdf',
    pageCount: pages.length,
    engine: 'test',
    pages: pages.map((items, index) => ({
      number: index + 1,
      width: 612,
      height: 792,
      rotation: 0,
      items,
      graphicRegions: [],
      warnings: [],
    })),
  };
}

function block(id: string, sourcePage: number, items: SourceText[]): ReadingBlock {
  return {
    id,
    kind: 'paragraph',
    sourcePage,
    sourceIds: items.map((entry) => entry.id),
    rect: { x: 36, y: items[0]?.y ?? 0, width: 300, height: 400 },
    rawText: items.map((entry) => entry.text).join('\n'),
    text: items.map((entry) => entry.text).join(' '),
    fontSize: 12,
    confidence: 'high',
  };
}

function reading(blocks: ReadingBlock[]): ReadingDocument {
  return { schemaVersion: 1, sourceHash: 'source-hash', blocks, warnings: [] };
}

function text(blockId: string, sourcePage: number, value: string, y = 34): TextPlacement {
  return {
    type: 'text',
    blockId,
    sourcePage,
    text: value,
    fontSize: 12,
    x: 34,
    y,
    width: 180,
    height: 18,
  };
}

function layout(pages: LayoutPage[]): LayoutDocument {
  return { pages, config: { ...DEFAULT_CONFIG }, warnings: [] };
}

function expectRect(actual: Rect, expected: Rect): void {
  for (const field of ['x', 'y', 'width', 'height'] as const)
    expect(actual[field]).toBeCloseTo(expected[field]);
}

describe('preserved object coordinate mapping', () => {
  it.each([90, 270] as const)(
    'maps an asymmetric landmark and a point through a %i° clockwise rotation and back',
    (rotation) => {
      const placement: RegionPlacement = {
        type: 'region',
        blockId: 'figure',
        sourcePage: 2,
        sourceRect: { x: 100, y: 50, width: 240, height: 120 },
        rotation,
        x: 20,
        y: 30,
        width: 180,
        height: 480,
      };
      const landmark = { x: 130, y: 70, width: 50, height: 20 };
      const output = regionRectToOutput(placement, landmark);
      expectRect(output, {
        x: rotation === 90 ? 140 : 50,
        y: rotation === 90 ? 90 : 350,
        width: 30,
        height: 100,
      });
      expectRect(regionRectToSource(placement, output), landmark);
      expectRect(regionRectToOutput(placement, placement.sourceRect), placement);
      expectRect(regionRectToSource(placement, placement), placement.sourceRect);

      const point = { x: 130, y: 70, width: 0, height: 0 };
      const mappedPoint = regionRectToOutput(placement, point);
      expectRect(mappedPoint, {
        x: rotation === 90 ? 170 : 50,
        y: rotation === 90 ? 90 : 450,
        width: 0,
        height: 0,
      });
      expectRect(regionRectToSource(placement, mappedPoint), point);
      expect(placement.sourceRect).toEqual({ x: 100, y: 50, width: 240, height: 120 });
    },
  );

  it('retains linear scaling when the object has no rotation', () => {
    const placement: RegionPlacement = {
      type: 'region',
      blockId: 'figure',
      sourcePage: 1,
      sourceRect: { x: 100, y: 50, width: 240, height: 120 },
      x: 20,
      y: 30,
      width: 360,
      height: 240,
    };
    const sourceRect = { x: 130, y: 70, width: 50, height: 20 };
    const output = regionRectToOutput(placement, sourceRect);
    expectRect(output, { x: 65, y: 70, width: 75, height: 40 });
    expectRect(regionRectToSource(placement, output), sourceRect);
  });
});

describe('content-based page links', () => {
  it.each([90, 270] as const)(
    'links the unrotated source crop to the whole %i° rotated result without a second transform',
    (rotation) => {
      const sourceRect = { x: 100, y: 50, width: 240, height: 120 };
      const placement: RegionPlacement = {
        type: 'region',
        blockId: 'object',
        sourcePage: 1,
        sourceRect,
        rotation,
        x: 20,
        y: 30,
        width: 180,
        height: 360,
      };
      const object: ReadingBlock = {
        ...block('object', 1, []),
        kind: 'sourceRegion',
        rect: sourceRect,
      };
      const links = buildPageLinks(
        source([[]]),
        reading([object]),
        layout([{ number: 2, sourcePages: [1], placements: [placement] }]),
      );
      const expected = {
        source: { page: 1, rect: sourceRect },
        output: { page: 2, rect: { x: 20, y: 30, width: 180, height: 360 } },
      };
      expect(links.bySource.get(1)).toEqual(expected);
      expect(links.byOutput.get(2)).toEqual(expected);
    },
  );

  it('ignores line-number decorations and uses the placed text start offset', () => {
    const items = [item('first', 'Repeated.', 40), item('second', 'Repeated.', 90)];
    const paragraph = block('paragraph', 1, items);
    paragraph.sourceSpans = [
      { sourceId: 'first', start: 0, end: 9, rect: items[0] },
      { sourceId: 'second', start: 9, end: 18, rect: items[1] },
    ];
    const links = buildPageLinks(
      source([items]),
      reading([paragraph]),
      layout([
        {
          number: 2,
          sourcePages: [1],
          placements: [
            { ...text('number', 1, '42', 24), decoration: 'lineNumber' },
            { ...text('paragraph', 1, 'Repeated.'), textStart: 9, textEnd: 18 },
          ],
        },
      ]),
    );
    expect(links.byOutput.get(2)?.source.rect.y).toBe(90);
    expect(links.byOutput.get(2)?.output.rect.y).toBe(34);
  });

  it('locates the original line when a paragraph continues onto later output pages', () => {
    const items = [
      item('first', 'The opening sentence belongs to the first line.', 40),
      item('second', 'The middle sentence belongs to the next line.', 90),
      item('third', 'The final sentence belongs to the last line.', 140),
    ];
    const document = source([items]);
    const pages = items.map((entry, index) => ({
      number: index + 1,
      sourcePages: [1],
      placements: [text('paragraph', 1, entry.text)],
    }));

    const links = buildPageLinks(document, reading([block('paragraph', 1, items)]), layout(pages));

    expect(links.byOutput.get(1)?.source.rect.y).toBe(40);
    expect(links.byOutput.get(2)?.source.rect.y).toBe(90);
    expect(links.byOutput.get(3)?.source.rect.y).toBe(140);
    expect(links.bySource.get(1)?.output.page).toBe(1);
  });

  it('advances through repeated text instead of returning to the first matching sentence', () => {
    const items = [
      item('first', 'Repeated sentence.', 40),
      item('second', 'Repeated sentence.', 90),
    ];
    const links = buildPageLinks(
      source([items]),
      reading([block('paragraph', 1, items)]),
      layout([
        { number: 1, sourcePages: [1], placements: [text('paragraph', 1, 'Repeated sentence.')] },
        { number: 2, sourcePages: [1], placements: [text('paragraph', 1, 'Repeated sentence.')] },
      ]),
    );

    expect(links.byOutput.get(1)?.source.rect.y).toBe(40);
    expect(links.byOutput.get(2)?.source.rect.y).toBe(90);
  });

  it('uses actual placement order and links source pages that begin midway down an output page', () => {
    const first = [item('page-one', 'Original page one.', 55)];
    const second = [item('page-two', 'Original page two.', 65)];
    const start = text('second', 2, 'Original page two.');
    const continuation = text('first', 1, 'Original page one.', 90);
    const links = buildPageLinks(
      source([first, second]),
      reading([block('second', 2, second), block('first', 1, first)]),
      layout([{ number: 1, sourcePages: [1, 2], placements: [start, continuation] }]),
    );

    expect(links.byOutput.get(1)?.source.page).toBe(2);
    expect(links.bySource.get(1)?.output).toEqual({
      page: 1,
      rect: { x: 34, y: 90, width: 180, height: 18 },
    });
    expect(links.bySource.get(2)?.output.rect.y).toBe(34);
  });

  it('links a preserved object using its source rectangle without requiring extracted text', () => {
    const objectRect = { x: 72, y: 170, width: 220, height: 130 };
    const objectBlock: ReadingBlock = {
      ...block('object', 1, []),
      kind: 'sourceRegion',
      rect: objectRect,
    };
    const links = buildPageLinks(
      source([[]]),
      reading([objectBlock]),
      layout([
        {
          number: 1,
          sourcePages: [1],
          placements: [
            {
              type: 'region',
              blockId: 'object',
              sourcePage: 1,
              sourceRect: objectRect,
              x: 34,
              y: 34,
              width: 220,
              height: 130,
            },
          ],
        },
      ]),
    );

    expect(links.byOutput.get(1)?.source).toEqual({ page: 1, rect: objectRect });
    expect(links.bySource.get(1)?.output.page).toBe(1);
  });

  it('ignores blank text and pages when selecting the first meaningful anchor', () => {
    const first = [item('first', 'Actual content.', 60)];
    const links = buildPageLinks(
      source([first]),
      reading([block('paragraph', 1, first)]),
      layout([
        { number: 1, sourcePages: [], placements: [] },
        {
          number: 2,
          sourcePages: [1],
          placements: [
            text('paragraph', 1, '   ', 20),
            text('paragraph', 1, 'Actual content.', 54),
          ],
        },
      ]),
    );

    expect(links.byOutput.has(1)).toBe(false);
    expect(links.byOutput.get(2)?.source.rect.y).toBe(60);
    expect(links.byOutput.get(2)?.output.rect.y).toBe(54);
    expect(links.bySource.get(1)?.output.page).toBe(2);
  });

  it('matches normalized ligatures and continuation after a removed line-end hyphen', () => {
    const items = [
      item('first', 'The oﬃce trans-', 40),
      item('second', 'formation is complete.', 90),
    ];
    const paragraph = block('paragraph', 1, items);
    paragraph.text = 'The office transformation is complete.';
    const links = buildPageLinks(
      source([items]),
      reading([paragraph]),
      layout([
        { number: 1, sourcePages: [1], placements: [text('paragraph', 1, 'The office trans')] },
        {
          number: 2,
          sourcePages: [1],
          placements: [text('paragraph', 1, 'formation is complete.')],
        },
      ]),
    );

    expect(links.byOutput.get(1)?.source.rect.y).toBe(40);
    expect(links.byOutput.get(2)?.source.rect.y).toBe(90);
  });
});
