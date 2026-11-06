import { describe, expect, it } from 'vitest';
import { detectRunningContent } from '../../src/core/running-content';
import type { SourceDocument, SourcePage, SourceText } from '../../src/core/model';

function item(
  id: string,
  text: string,
  x: number,
  y: number,
  width: number,
  fontSize = 9,
): SourceText {
  return {
    id,
    text,
    x,
    y,
    width,
    height: fontSize,
    fontSize,
    fontName: 'Book serif',
    hasEOL: true,
  };
}
function page(number: number, extra: SourceText[] = []): SourcePage {
  return {
    number,
    width: 600,
    height: 800,
    rotation: 0,
    items: [
      item(
        `body-${number}-a`,
        'This is an ordinary long body paragraph on the source page.',
        50,
        100,
        490,
        12,
      ),
      item(
        `body-${number}-b`,
        'Its next line is close to the previous line of body text.',
        50,
        116,
        490,
        12,
      ),
      item(
        `body-${number}-c`,
        'The final body line supplies normal prose font-size evidence.',
        50,
        132,
        490,
        12,
      ),
      ...extra,
    ],
    graphicRegions: [],
    warnings: [],
  };
}
function document(pages: SourcePage[], pageCount = pages.length): SourceDocument {
  return {
    schemaVersion: 1,
    hash: 'book',
    name: 'book.pdf',
    engine: 'synthetic',
    pageCount,
    pages,
  };
}
function bookPage(number: number, title = 'Chapter one'): SourcePage {
  const odd = number % 2 === 1;
  return page(number, [
    item(`head-${number}`, odd ? `Author — ${title}` : title, odd ? 65 : 350, 26, odd ? 210 : 190),
    item(`folio-${number}`, String(number + 20), odd ? 42 : 548, 26, 12),
  ]);
}

describe('running headers and footers', () => {
  it('recognizes consistent larger header folios above compact table text', () => {
    const pages = [1, 2, 3].map((number) => ({
      ...page(number),
      items: [
        ...page(number).items.map((item) => ({ ...item, fontSize: 7.5, height: 7.5 })),
        item(`folio-${number}`, String(number + 20), 42, 28, 12, 10),
        item(`title-${number}`, 'CHAPTER 1 DESIGN PROCESS', 70, 30, 180, 7.5),
      ],
    }));
    const running = detectRunningContent(document(pages));
    for (const number of [1, 2, 3]) {
      expect(running.get(number)?.pageNumberIds).toEqual([`folio-${number}`]);
      expect(running.get(number)?.headerIds).toEqual([`title-${number}`]);
    }
  });

  it('recognizes repeated edge chapter tabs while retaining nearby plot axis labels', () => {
    const pages = [1, 2, 3, 4, 5, 6, 7].map((number) => {
      const tab = {
        ...item(`tab-${number}`, 'THERMAL CONTROL', 4, 100, 10, 12),
        height: 100,
        rotation: -90,
        preserve: true,
      };
      const axis = { ...tab, id: `axis-${number}`, y: 400 };
      const original = number === 7 ? page(number) : bookPage(number);
      return {
        ...original,
        items: [...original.items, tab, axis],
        graphicRegions: [{ x: 20, y: 380, width: 250, height: 150 }],
      };
    });
    const running = detectRunningContent(document(pages));
    for (const number of [1, 2, 3, 4, 5, 6, 7])
      expect(running.get(number)?.footerIds).toEqual([`tab-${number}`]);
  });

  it('recognizes a compact repeated access footer with varying creation timestamps', () => {
    const pages = [1, 2, 3].map((number) =>
      page(number, [
        item(
          `citation-${number}`,
          'Author. A scientific book. Publisher Ebook Library.',
          10,
          764,
          310,
          6,
        ),
        item(`url-${number}`, 'https://library.example.com/books/detail?id=12345', 25, 771, 250, 6),
        item(
          `created-${number}`,
          `Created from the university library on 2022-07-0${number} 06:39:47.`,
          10,
          778,
          240,
          6,
        ),
        item(`note-${number}`, '1 This is an ordinary numbered footnote.', 50, 706, 300, 9),
      ]),
    );
    const running = detectRunningContent(document(pages));
    for (const number of [1, 2, 3])
      expect(running.get(number)?.footerIds).toEqual([
        `citation-${number}`,
        `url-${number}`,
        `created-${number}`,
      ]);
  });

  it('separates repeated shorter copyright side marks while retaining interior axis labels', () => {
    const pages = [1, 2, 3].map((number) => {
      const copyright = {
        ...item(
          `copyright-${number}`,
          'Copyright © 2018. Publisher. All rights reserved.',
          4,
          460,
          6,
          6,
        ),
        height: 190,
        rotation: -90,
        preserve: true,
      };
      return page(number, [copyright, { ...copyright, id: `axis-${number}`, x: 100 }]);
    });
    const running = detectRunningContent(document(pages));
    for (const number of [1, 2, 3])
      expect(running.get(number)?.footerIds).toEqual([`copyright-${number}`]);
  });

  it('keeps recurring vertical download marks out of prose and out of horizontal header rows', () => {
    const pages = [1, 2, 3, 4].map((number) => {
      const original = bookPage(number);
      original.items.push({
        ...item(
          `stamp-${number}`,
          'Downloaded from the publisher library under the applicable open access licence.',
          585,
          15,
          5,
          5,
        ),
        height: 770,
        preserve: true,
        rotation: 90,
      });
      return original;
    });
    const running = detectRunningContent(document(pages));
    for (const number of [1, 2, 3, 4]) {
      expect(running.get(number)?.footerIds).toEqual([`stamp-${number}`]);
      expect(running.get(number)?.pageNumberIds).toEqual([`folio-${number}`]);
      expect(running.get(number)?.headerIds).toEqual([`head-${number}`]);
    }
  });

  it('recognizes a larger repeated journal wordmark beside a small running title', () => {
    const pages = [1, 2, 3].map((number) =>
      page(number, [
        item(`brand-${number}`, 'PLOS ONE', 35, 30, 75, 16),
        item(`title-${number}`, 'A repeated research article title', 350, 35, 210, 9),
      ]),
    );
    const running = detectRunningContent(document(pages));
    for (const number of [1, 2, 3])
      expect(running.get(number)?.headerIds).toEqual([`brand-${number}`, `title-${number}`]);
  });

  it('keeps a recurring DOI footer and outer volume mark out of the body', () => {
    const pages = [1, 2, 3].map((number) =>
      page(number, [
        item(`doi-${number}`, 'Journal | https://doi.org/10.1234/article', 40, 748, 360, 9),
        item(`counter-${number}`, `${number} / 20`, 540, 748, 25, 9),
        item(`volume-${number}`, 'Vol.:(0123456789)', 480, 778, 90, 8),
      ]),
    );
    const running = detectRunningContent(document(pages));
    for (const number of [1, 2, 3]) {
      expect(running.get(number)?.footerIds).toEqual([`doi-${number}`, `volume-${number}`]);
      expect(running.get(number)?.pageNumberIds).toEqual([`counter-${number}`]);
    }
  });

  it('retains a one-off DOI in a source note', () => {
    const result = detectRunningContent(
      document([
        page(1, [item('note-url', 'https://doi.org/10.1234/specific-note', 50, 750, 300)]),
      ]),
    );
    expect(result.get(1)?.footerIds ?? []).not.toContain('note-url');
  });

  it('uses a proven outer footer position for a corrupt Unicode mapping', () => {
    const pages = [1, 2, 3, 4].map((number) =>
      page(number, [
        item(
          `volume-${number}`,
          number === 1 ? '\u0019ol.:(0123456789)' : 'Vol.:(0123456789)',
          480,
          778,
          90,
          8,
        ),
      ]),
    );
    expect(detectRunningContent(document(pages)).get(1)?.footerIds).toEqual(['volume-1']);
  });

  it('uses marginal Artifact evidence without treating all marked artifacts as running text', () => {
    const pages = [1, 2].map((number) =>
      page(number, [
        {
          ...item(`artifact-head-${number}`, 'Publisher running head', 50, 26, 260, 14),
          artifact: true,
        },
        {
          ...item(
            `artifact-body-${number}`,
            'This artifact is still ordinary visible body content.',
            50,
            400,
            490,
            12,
          ),
          artifact: true,
        },
      ]),
    );
    const running = detectRunningContent(document(pages));
    expect(running.get(1)?.headerIds).toEqual(['artifact-head-1']);
    expect(running.get(2)?.headerIds).toEqual(['artifact-head-2']);
    for (const content of running.values())
      expect(content.headerIds.some((id) => id.includes('body'))).toBe(false);
  });

  it('recognizes alternating book headers and separates their changing folios', () => {
    const source = document(Array.from({ length: 6 }, (_, index) => bookPage(index + 1)));
    const before = JSON.stringify(source);
    const running = detectRunningContent(source);
    for (let number = 1; number <= 6; number++) {
      expect(running.get(number)).toEqual({
        headerIds: [`head-${number}`],
        footerIds: [],
        pageNumberIds: [`folio-${number}`],
      });
    }
    expect(JSON.stringify(source)).toBe(before);
  });

  it('uses proven header positions for changing chapter titles without requiring the full book', () => {
    const pages = Array.from({ length: 6 }, (_, index) =>
      bookPage(index + 1, index < 4 ? 'Chapter one' : 'A different chapter'),
    );
    const running = detectRunningContent(document(pages, 267));
    expect(running.get(5)?.headerIds).toEqual(['head-5']);
    expect(running.get(6)?.headerIds).toEqual(['head-6']);
  });

  it('leaves a new chapter heading in the body even when it occupies a header-like location', () => {
    const chapter = page(5, [
      item('chapter-number', 'Chapter 2', 50, 26, 180, 16),
      item('chapter-title', 'Building and its environment', 50, 55, 430, 22),
    ]);
    const running = detectRunningContent(
      document([bookPage(1), bookPage(2), bookPage(3), bookPage(4), chapter]),
    );
    expect(running.has(5)).toBe(false);
  });

  it('keeps an unnumbered first-page title when its size matches later running heads', () => {
    const first = page(1, [item('first-title', 'Introduction', 350, 26, 190)]);
    const running = detectRunningContent(
      document([first, bookPage(2), bookPage(3), bookPage(4), bookPage(5)]),
    );
    expect(running.get(1)?.headerIds ?? []).not.toContain('first-title');
  });

  it('requires additional evidence before removing a repeated heading from a short document', () => {
    const pages = [1, 2].map((number) =>
      page(number, [item(`section-${number}`, 'Methods', 50, 30, 180, 12)]),
    );
    expect(detectRunningContent(document(pages)).size).toBe(0);
  });

  it('recognizes an alternating plain running title without folios on a longer selection', () => {
    const pages = Array.from({ length: 6 }, (_, index) =>
      page(index + 1, [
        item(`title-${index + 1}`, index % 2 ? 'Book title' : 'Chapter title', 50, 26, 220),
      ]),
    );
    const running = detectRunningContent(document(pages));
    expect(running.get(1)?.headerIds).toEqual(['title-1']);
    expect(running.get(2)?.headerIds).toEqual(['title-2']);
  });

  it('detects repeated textual footers and sequential separate folios', () => {
    const pages = [1, 2, 3].map((number) =>
      page(number, [
        item(`foot-${number}`, 'Publishing house', 240, 745, 120),
        item(`folio-${number}`, String(number), 295, 777, 10),
      ]),
    );
    const running = detectRunningContent(document(pages));
    expect(running.get(2)).toEqual({
      headerIds: [],
      footerIds: ['foot-2'],
      pageNumberIds: ['folio-2'],
    });
  });

  it('recognizes standalone page counters with a prefix or total', () => {
    const pages = [1, 2].map((number) =>
      page(number, [item(`counter-${number}`, `Page ${number} of 20`, 250, 755, 100)]),
    );
    const running = detectRunningContent(document(pages));
    expect(running.get(1)?.pageNumberIds).toEqual(['counter-1']);
    expect(running.get(2)?.pageNumberIds).toEqual(['counter-2']);
  });

  it('accepts an isolated folio on a single page only when it is at a true page edge', () => {
    const running = detectRunningContent(document([page(1, [item('folio', '7', 296, 778, 8)])]));
    expect(running.get(1)?.pageNumberIds).toEqual(['folio']);
    expect(detectRunningContent(document([page(1, [item('number', '7', 296, 710, 8)])])).size).toBe(
      0,
    );
  });

  it('handles lowercase Roman front matter while excluding ordinary Roman-looking words', () => {
    const running = detectRunningContent(document([page(1, [item('roman', 'iv', 294, 778, 12)])]));
    expect(running.get(1)?.pageNumberIds).toEqual(['roman']);
    for (const word of ['mix', 'civil', 'div', 'liv']) {
      const result = detectRunningContent(document([page(1, [item('word', word, 290, 778, 25)])]));
      expect(result.get(1)?.pageNumberIds ?? []).not.toContain('word');
    }
  });

  it('preserves numbered and continued footnotes rather than treating them as footer furniture', () => {
    const pages = [1, 2, 3].map((number) =>
      page(number, [
        item(`note-label-${number}`, String(number), 50, 714, 7, 8),
        item(
          `note-body-${number}`,
          'This note explains the particular claim in the body.',
          62,
          714,
          430,
          9,
        ),
        item(
          `note-next-${number}`,
          'Its continuation must remain part of the original note.',
          62,
          726,
          430,
          9,
        ),
      ]),
    );
    const running = detectRunningContent(document(pages));
    for (const number of [1, 2, 3]) expect(running.get(number)).toBeUndefined();
  });

  it('respects tagged headings, notes and table headings even at the page edge', () => {
    const pages = [1, 2, 3].map((number) =>
      page(number, [
        { ...item(`heading-${number}`, 'Repeated heading', 50, 26, 200), structureRoles: ['H2'] },
        {
          ...item(`note-${number}`, 'Repeated semantic note', 50, 750, 200),
          structureRoles: ['Note', 'P'],
        },
      ]),
    );
    expect(detectRunningContent(document(pages)).size).toBe(0);
  });

  it('does not classify a compact untagged table header or a repeated caption as running text', () => {
    const pages = [1, 2, 3].map((number) => {
      const original = page(number, [
        item(`table-${number}`, 'Property and value', 50, 32, 400, 10),
        item(`caption-${number}`, 'Figure 1.2 A repeated figure caption', 50, 750, 400, 9),
      ]);
      original.graphicRegions = [{ x: 40, y: 25, width: 520, height: 180 }];
      return original;
    });
    expect(detectRunningContent(document(pages)).size).toBe(0);
  });

  it('never moves recurring body prose into margins solely because its text repeats', () => {
    const pages = [1, 2, 3, 4].map((number) =>
      page(number, [
        item(`body-repeat-${number}`, 'A repeated sentence belongs to the body.', 50, 500, 450, 12),
        item(
          `body-top-${number}`,
          'A first body line close to its following line.',
          50,
          60,
          490,
          12,
        ),
        item(
          `body-top-next-${number}`,
          'The next body line is directly below it.',
          50,
          76,
          490,
          12,
        ),
      ]),
    );
    expect(detectRunningContent(document(pages)).size).toBe(0);
  });
});
