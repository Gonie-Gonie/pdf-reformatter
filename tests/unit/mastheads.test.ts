import { describe, expect, it } from 'vitest';
import { mastheadBoundary } from '../../src/core/mastheads';
import type { Rect, SourcePage, SourceText } from '../../src/core/model';

function text(
  id: string,
  value: string,
  x: number,
  y: number,
  width: number,
  fontSize = 10,
  structureRoles?: string[],
): SourceText {
  return {
    id,
    text: value,
    x,
    y,
    width,
    height: fontSize,
    fontSize,
    fontName: 'serif',
    hasEOL: true,
    structureRoles,
  };
}

function page(graphicRegions: Rect[], extraItems: SourceText[] = []): SourcePage {
  return {
    number: 2,
    width: 600,
    height: 800,
    rotation: 0,
    graphicRegions,
    warnings: [],
    items: [
      text('journal', 'Journal of a scientific discipline', 60, 54, 200, 7.5),
      text('doi', 'https://doi.org/10.example/article', 60, 65, 170, 7.5),
      text('title', 'A general article title with enough words', 60, 104, 440, 14, ['H1']),
      ...Array.from({ length: 8 }, (_, index) =>
        text(
          'body-' + index,
          'Body text fills a column on the article page.',
          60,
          200 + index * 14,
          240,
        ),
      ),
      ...extraItems,
    ],
  };
}

describe('isolated article mastheads', () => {
  it('separates a merged logo, journal text and divider above a tagged title', () => {
    expect(mastheadBoundary(page([{ x: 59, y: 10, width: 493, height: 82 }]))).toBe(92);
  });

  it('supports a distinct horizontal divider below a substantial logo', () => {
    expect(
      mastheadBoundary(
        page([
          { x: 440, y: 20, width: 105, height: 50 },
          { x: 60, y: 90, width: 490, height: 1 },
        ]),
      ),
    ).toBe(91);
  });

  it('can use an untagged but distinctly larger cover title', () => {
    const source = page([{ x: 20, y: 17, width: 560, height: 134 }]);
    source.items = source.items.map((item) =>
      item.id === 'title'
        ? { ...item, y: 167, fontSize: 18, height: 18, structureRoles: [] }
        : item,
    );
    expect(mastheadBoundary(source)).toBe(151);
  });

  it('recognizes H1 membership provided only by the structure tree', () => {
    const source = page([{ x: 59, y: 10, width: 493, height: 82 }]);
    source.items = source.items.map((item) =>
      item.id === 'title' ? { ...item, structureRoles: [], fontSize: 12.5 } : item,
    );
    source.structure = [{ id: 'heading', role: 'H1', sourceIds: ['title'], order: 0 }];
    expect(mastheadBoundary(source)).toBe(92);
  });

  it('rejects a plot identified by a caption before a section heading', () => {
    expect(
      mastheadBoundary(
        page(
          [{ x: 59, y: 10, width: 493, height: 70 }],
          [text('caption', 'Figure 1. An experimental result.', 60, 82, 300, 8)],
        ),
      ),
    ).toBeUndefined();
  });

  it('recognizes captions emitted as separate words', () => {
    expect(
      mastheadBoundary(
        page(
          [{ x: 59, y: 10, width: 493, height: 70 }],
          [
            text('caption-word', 'Figure', 60, 82, 25, 8),
            text('caption-number', '2.', 88, 82, 8, 8),
          ],
        ),
      ),
    ).toBeUndefined();
  });

  it('rejects tagged figure content even without a printed caption', () => {
    expect(
      mastheadBoundary(
        page(
          [{ x: 59, y: 10, width: 493, height: 82 }],
          [text('axis', 'Measured energy', 90, 32, 110, 8, ['Figure'])],
        ),
      ),
    ).toBeUndefined();
  });

  it('does not treat an ordinary running header and rule as a masthead', () => {
    expect(
      mastheadBoundary(
        page([
          { x: 60, y: 20, width: 15, height: 15 },
          { x: 60, y: 90, width: 490, height: 1 },
        ]),
      ),
    ).toBeUndefined();
  });

  it('rejects body prose above a title rather than promoting it to a masthead', () => {
    expect(
      mastheadBoundary(
        page(
          [{ x: 59, y: 10, width: 493, height: 82 }],
          [
            text(
              'prose',
              'A normal paragraph continues here with sufficient words to be recognized as flowing body text before a later section.',
              60,
              30,
              490,
            ),
          ],
        ),
      ),
    ).toBeUndefined();
  });

  it('requires a title and valid geometry', () => {
    const source = page([{ x: 59, y: 10, width: 493, height: 82 }]);
    source.items = source.items.filter((item) => item.id !== 'title');
    expect(mastheadBoundary(source)).toBeUndefined();
    expect(mastheadBoundary({ ...source, width: Number.NaN })).toBeUndefined();
  });
});
