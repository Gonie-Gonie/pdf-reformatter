import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/core/config';
import { buildPageLinks } from '../../src/core/navigation';
import type {
  LayoutDocument,
  LayoutPage,
  ReadingBlock,
  ReadingDocument,
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

describe('content-based page links', () => {
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
