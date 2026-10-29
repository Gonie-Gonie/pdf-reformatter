import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/core/config';
import { findLayoutAnchor, layoutDocument } from '../../src/core/layout';
import type {
  LayoutConfig,
  LayoutDocument,
  ReadingBlock,
  ReadingDocument,
  TextPlacement,
} from '../../src/core/model';

const config: LayoutConfig = {
  ...DEFAULT_CONFIG,
  pageWidthPt: 260,
  pageHeightPt: 170,
  marginTopPt: 12,
  marginBottomPt: 12,
  marginLeftPt: 12,
  marginRightPt: 12,
  fontSizePt: 12,
  lineHeightPt: 20,
};
const measure = (text: string, size: number) => [...text].length * size * 0.5;
const normalized = (text: string) => text.normalize('NFKC').replace(/[\s\u00ad]/gu, '');

function paragraph(id: string, parts: string[], separator = ' '): ReadingBlock {
  let offset = 0;
  return {
    id,
    kind: 'paragraph',
    sourcePage: 1,
    sourceIds: parts.map((_, index) => `${id}-s${index}`),
    rect: { x: 40, y: 40, width: 400, height: 600 },
    rawText: parts.join('\n'),
    text: parts.join(separator),
    fontSize: 12,
    confidence: 'high',
    sourceSpans: parts.map((text, index) => {
      const start = offset;
      offset += normalized(text).length;
      return {
        sourceId: `${id}-s${index}`,
        start,
        end: offset,
        rect: { x: 40, y: 40 + index * 20, width: measure(text, 12), height: 12 },
      };
    }),
  };
}

function number(id: string, target: ReadingBlock, sourceIndex: number, value = id): ReadingBlock {
  return {
    id,
    kind: 'lineNumber',
    sourcePage: 1,
    sourceIds: [id],
    rect: { x: 16, y: 40 + sourceIndex * 20, width: 16, height: 8 },
    rawText: value,
    text: value,
    fontSize: 8,
    confidence: 'high',
    anchor: { blockId: target.id, sourceId: target.sourceIds[sourceIndex] },
  };
}

function document(blocks: ReadingBlock[]): ReadingDocument {
  return { schemaVersion: 1, sourceHash: 'source', blocks, warnings: [] };
}

function texts(layout: LayoutDocument): TextPlacement[] {
  return layout.pages
    .flatMap((page) => page.placements)
    .filter((placement): placement is TextPlacement => placement.type === 'text');
}

describe('anchored source content', () => {
  it('finds an original line start midway through a reflowed line', () => {
    const body = paragraph('body', ['alpha', 'beta', 'gamma']);
    const reading = document([body]);
    const layout = layoutDocument(reading, config, measure);
    const first = texts(layout)[0];
    const anchor = findLayoutAnchor(
      layout,
      reading,
      { blockId: body.id, sourceId: 'body-s1' },
      measure,
    )!;

    expect(anchor.page).toBe(1);
    expect(anchor.rect.x).toBeCloseTo(first.x + measure('alpha ', 12));
    expect(anchor.rect.y).toBe(first.y);
    expect(anchor.rect.width).toBe(measure('b', 12));
    expect(first.textStart).toBe(0);
    expect(first.textEnd).toBe(normalized(body.text).length);
  });

  it('maps normalized offsets to the actual source glyph even when a ligature expands', () => {
    const body = paragraph('body', ['oﬃce']);
    const reading = document([body]);
    const layout = layoutDocument(reading, config, measure);
    const line = texts(layout)[0];
    const insideLigature = findLayoutAnchor(
      layout,
      reading,
      { blockId: body.id, sourceId: 'body-s0', offset: 3 },
      measure,
    )!;
    const afterLigature = findLayoutAnchor(
      layout,
      reading,
      { blockId: body.id, sourceId: 'body-s0', offset: 4 },
      measure,
    )!;

    expect(insideLigature.rect.x).toBe(line.x + measure('o', 12));
    expect(afterLigature.rect.x).toBe(line.x + measure('oﬃ', 12));
  });

  it('places a line number on the page containing its source start, once only', () => {
    const body = paragraph(
      'body',
      Array.from({ length: 9 }, (_, index) => String.fromCharCode(97 + index).repeat(34)),
    );
    const marker = number('108', body, 7);
    const reading = document([body, marker]);
    const layout = layoutDocument(reading, config, measure);
    const anchor = findLayoutAnchor(layout, reading, marker.anchor!, measure)!;
    const labels = layout.pages.flatMap((page) =>
      page.placements
        .filter((item) => item.blockId === marker.id)
        .map((item) => ({ page: page.number, item })),
    );
    const bodyLines = texts(layout).filter((item) => !item.decoration);

    expect(anchor.page).toBeGreaterThan(1);
    expect(labels).toHaveLength(1);
    expect(labels[0].page).toBe(anchor.page);
    expect(labels[0].item.type).toBe('text');
    expect(bodyLines.map((item) => normalized(item.text)).join('')).toBe(normalized(body.text));
    expect(bodyLines.at(-1)?.textEnd).toBe(normalized(body.text).length);
  });

  it('uses existing leading for an extra same-line marker without covering body glyphs', () => {
    const body = paragraph('body', ['alpha', 'beta', 'gamma']);
    const markers = [number('101', body, 0), number('102', body, 1)];
    const reading = document([body, ...markers]);
    const layout = layoutDocument(reading, config, measure);
    const placements = texts(layout);
    const line = placements.find((item) => item.blockId === body.id)!;
    const first = placements.find((item) => item.blockId === '101')!;
    const second = placements.find((item) => item.blockId === '102')!;
    const anchor = findLayoutAnchor(layout, reading, markers[1].anchor!, measure)!;

    expect(layout.pages).toHaveLength(1);
    expect(placements.filter((item) => item.decoration)).toHaveLength(2);
    expect(first.x + first.width).toBeLessThan(line.x);
    expect(first.y + first.fontSize).toBeCloseTo(line.y + line.fontSize);
    expect(second.x).toBeCloseTo(anchor.rect.x);
    expect(second.y).toBeGreaterThanOrEqual(config.marginTopPt);
    expect(second.y + second.height).toBeLessThanOrEqual(line.y);
    expect(line.y + line.height).toBe(config.marginTopPt + config.lineHeightPt);
  });

  it('packs colliding starts into the gutter without dropping or overlapping labels', () => {
    const body = paragraph('body', ['a', 'b', 'c'], '');
    const markers = ['101', '102', '103'].map((value, index) => number(value, body, index));
    const reading = document([body, ...markers]);
    const layout = layoutDocument(reading, config, measure);
    const placements = texts(layout);
    const line = placements.find((item) => item.blockId === body.id)!;
    const labels = placements.filter((item) => item.decoration).sort((a, b) => a.x - b.x);

    expect(labels.map((item) => item.text)).toEqual(['101', '102', '103']);
    expect(
      labels.every((item) => item.x >= config.marginLeftPt && item.x + item.width < line.x),
    ).toBe(true);
    for (let index = 1; index < labels.length; index++) {
      expect(labels[index].x).toBeGreaterThan(labels[index - 1].x + labels[index - 1].width);
      expect(labels[index].fontSize).toBe(labels[0].fontSize);
    }
    expect(
      placements
        .filter((item) => !item.decoration)
        .map((item) => item.text)
        .join(''),
    ).toBe('abc');
  });

  it('uses the gutter when configured leading has no room for raised markers', () => {
    const body = paragraph('body', ['alpha', 'beta']);
    const reading = document([body, number('1', body, 0), number('2', body, 1)]);
    const layout = layoutDocument(reading, { ...config, lineHeightPt: 13 }, measure);
    const placements = texts(layout);
    const line = placements.find((item) => !item.decoration)!;
    const labels = placements.filter((item) => item.decoration);

    expect(line.y).toBe(config.marginTopPt);
    expect(labels).toHaveLength(2);
    expect(labels.every((item) => item.x + item.width < line.x)).toBe(true);
    expect(labels[0].y + labels[0].fontSize).toBeCloseTo(line.y + line.fontSize);
  });

  it('reports insufficient marker space rather than dropping labels or making them invisible', () => {
    const body = paragraph(
      'body',
      Array.from({ length: 12 }, () => 'x'),
      '',
    );
    const markers = body.sourceIds.map((_, index) => number(String(1000 + index), body, index));
    expect(() => layoutDocument(document([body, ...markers]), config, measure)).toThrow(/줄번호/u);
  });

  it('transforms source-object anchors and keeps their labels beside the mapped object row', () => {
    const object: ReadingBlock = {
      ...paragraph('figure', ['figure label']),
      kind: 'sourceRegion',
      rect: { x: 0, y: 0, width: 100, height: 200 },
      sourceSpans: [
        {
          sourceId: 'figure-s0',
          start: 0,
          end: 11,
          rect: { x: 20, y: 140, width: 40, height: 10 },
        },
      ],
    };
    const marker = number('42', object, 0);
    const reading = document([object, marker]);
    const layout = layoutDocument(reading, config, measure);
    const placement = layout.pages[0].placements.find((item) => item.type === 'region')!;
    const anchor = findLayoutAnchor(layout, reading, marker.anchor!, measure)!;
    const label = texts(layout).find((item) => item.blockId === marker.id)!;

    expect(anchor.rect.x).toBeCloseTo(placement.x + placement.width * 0.2);
    expect(anchor.rect.y).toBeCloseTo(placement.y + placement.height * 0.7);
    expect(anchor.rect.width).toBeCloseTo(placement.width * 0.4);
    expect(label.y + label.fontSize).toBeCloseTo(anchor.rect.y + anchor.rect.height);
    expect(label.x + label.width).toBeLessThan(placement.x);
  });

  it('moves a whole note to the next page when it fits there and still splits oversized notes', () => {
    const body = paragraph(
      'body',
      Array.from({ length: 4 }, () => 'a'.repeat(32)),
    );
    const note: ReadingBlock = {
      ...paragraph(
        'note',
        Array.from({ length: 3 }, () => 'n'.repeat(35)),
      ),
      kind: 'footnote',
      semantic: 'note',
      keepTogether: true,
    };
    const reading = document([body, note]);
    const layout = layoutDocument(reading, config, measure);
    const pages = layout.pages.filter((page) =>
      page.placements.some((item) => item.blockId === note.id),
    );

    expect(pages.map((page) => page.number)).toEqual([2]);
    expect(
      texts(layout)
        .filter((item) => item.blockId === note.id)
        .map((item) => normalized(item.text))
        .join(''),
    ).toBe(normalized(note.text));

    const longNote = {
      ...paragraph(
        'long',
        Array.from({ length: 12 }, () => 'n'.repeat(35)),
      ),
      kind: 'footnote' as const,
      semantic: 'note' as const,
      keepTogether: true,
    };
    const oversized = layoutDocument(document([longNote]), config, measure);
    expect(oversized.pages.length).toBeGreaterThan(1);
    expect(
      texts(oversized)
        .map((item) => normalized(item.text))
        .join(''),
    ).toBe(normalized(longNote.text));
  });
});
