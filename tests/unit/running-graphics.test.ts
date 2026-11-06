import { describe, expect, it } from 'vitest';
import { runningGraphicContent } from '../../src/core/running-graphics';
import type { SourceDocument, SourcePage, SourceText } from '../../src/core/model';

function item(
  id: string,
  text: string,
  x: number,
  y: number,
  width: number,
  artifact = true,
): SourceText {
  return {
    id,
    text,
    x,
    y,
    width,
    height: artifact ? 7.5 : 10,
    fontSize: artifact ? 7.5 : 10,
    fontName: 'serif',
    artifact,
    hasEOL: true,
  };
}

function page(number = 3): SourcePage {
  return {
    number,
    width: 600,
    height: 800,
    rotation: 0,
    warnings: [],
    graphicRegions: [{ x: 69, y: 23, width: 15, height: 15 }],
    items: [
      item('folio', '2', 59, 27.5, 4),
      item('initial', 'H.', 89, 27.5, 7),
      item('surname', 'LI', 97, 27.5, 7),
      item('et', 'ET', 105, 27.5, 8),
      item('al', 'AL.', 114, 27.5, 10),
      ...Array.from({ length: 6 }, (_, index) =>
        item(
          'body-' + index,
          'Normal prose provides body font evidence.',
          59,
          80 + index * 14,
          240,
          false,
        ),
      ),
    ],
  };
}

function document(pages: SourcePage[]): SourceDocument {
  return {
    schemaVersion: 1,
    name: 'article.pdf',
    hash: 'article',
    engine: 'synthetic',
    pageCount: pages.length,
    pages,
  };
}

describe('Artifact-supported running header graphics', () => {
  it('keeps a tiny image with its header row and separates the old folio', () => {
    const source = document([page()]);
    const before = JSON.stringify(source);
    expect(runningGraphicContent(source).get(3)).toEqual({
      regions: [{ x: 69, y: 23, width: 15, height: 15 }],
      headerIds: ['initial', 'surname', 'et', 'al'],
      pageNumberIds: ['folio'],
    });
    expect(JSON.stringify(source)).toBe(before);
  });

  it('supports the mirrored header on the opposite page', () => {
    const right = page(4);
    right.graphicRegions = [{ x: 525, y: 23, width: 15, height: 15 }];
    right.items = [
      item('title', 'JOURNAL OF RESEARCH', 355, 27.5, 165),
      item('folio', '3', 546, 27.5, 4),
      ...right.items.filter((entry) => !entry.artifact),
    ];
    expect(runningGraphicContent(document([right])).get(4)).toMatchObject({
      headerIds: ['title'],
      pageNumberIds: ['folio'],
    });
  });

  it('requires Artifact evidence for both header words and the separate folio', () => {
    const source = page();
    source.items = source.items.map((entry) => ({ ...entry, artifact: false }));
    expect(runningGraphicContent(document([source])).size).toBe(0);
    const noFolio = page();
    noFolio.items = noFolio.items.filter((entry) => entry.id !== 'folio');
    expect(runningGraphicContent(document([noFolio])).size).toBe(0);
  });

  it('does not infer a header from an isolated Artifact page number', () => {
    const source = page();
    source.items = source.items.filter((entry) => !entry.artifact || entry.id === 'folio');
    expect(runningGraphicContent(document([source])).size).toBe(0);
  });

  it('leaves graphics near nonartifact prose or captions in the body', () => {
    const source = page();
    source.items.push(item('caption', 'Figure 1. An experimental plot.', 59, 43, 220, false));
    expect(runningGraphicContent(document([source])).size).toBe(0);
  });

  it('rejects tagged figure labels even if they were marked as artifacts', () => {
    const source = page();
    source.items.find((entry) => entry.id === 'surname')!.structureRoles = ['Figure'];
    expect(runningGraphicContent(document([source])).size).toBe(0);
  });

  it('rejects a top illustration or a larger illustration enclosing the row', () => {
    const source = page();
    source.graphicRegions[0].width = 250;
    expect(runningGraphicContent(document([source])).size).toBe(0);
    const enclosing = page();
    enclosing.graphicRegions.push({ x: 50, y: 10, width: 300, height: 200 });
    expect(runningGraphicContent(document([enclosing])).size).toBe(0);
  });

  it('requires matching vertical alignment, nearby text and valid page geometry', () => {
    const misplaced = page();
    misplaced.graphicRegions[0].y = 55;
    expect(runningGraphicContent(document([misplaced])).size).toBe(0);
    const far = page();
    far.graphicRegions[0].x = 400;
    expect(runningGraphicContent(document([far])).size).toBe(0);
    expect(runningGraphicContent(document([{ ...page(), width: Number.NaN }])).size).toBe(0);
  });
});
