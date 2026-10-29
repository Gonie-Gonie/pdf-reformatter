import { describe, expect, it } from 'vitest';
import { analyzeDocument } from '../../src/core/analyze';
import type {
  ReadingDocument,
  SourceDocument,
  SourcePage,
  SourceStructure,
  SourceText,
} from '../../src/core/model';

function item(
  id: string,
  text: string,
  x = 48,
  y = 70,
  width = 430,
  fontSize = 12,
  roles?: string[],
): SourceText {
  return {
    id,
    text,
    x,
    y,
    width,
    height: fontSize,
    fontSize,
    fontName: 'NotoSerif',
    hasEOL: true,
    ...(roles ? { structureRoles: roles } : {}),
  };
}
function page(items: SourceText[], number = 1, structure?: SourceStructure[]): SourcePage {
  return {
    number,
    width: 612,
    height: 792,
    rotation: 0,
    items,
    graphicRegions: [],
    warnings: [],
    ...(structure ? { structure } : {}),
  };
}
function document(pages: SourcePage[]): SourceDocument {
  return {
    schemaVersion: 1,
    hash: 'hash',
    name: 'semantic.pdf',
    pageCount: pages.length,
    pages,
    engine: 'test',
  };
}
function group(
  id: string,
  role: string,
  sourceIds: string[],
  order: number,
  parentId?: string,
): SourceStructure {
  return { id, role, sourceIds, order, ...(parentId ? { parentId } : {}) };
}
function owned(reading: ReadingDocument, source: SourceDocument) {
  const ids = reading.blocks.flatMap((block) => block.sourceIds);
  expect([...ids].sort()).toEqual(
    source.pages.flatMap((page) => page.items.map((item) => item.id)).sort(),
  );
  expect(new Set(ids).size).toBe(ids.length);
}

describe('semantic PDF analysis', () => {
  it.each(['Contents', 'Index'])(
    'keeps an untagged multiline %s entry with its reference numbers',
    (heading) => {
      const entries = [
        item('heading', heading, 48, 30, 150, 18),
        item('title', 'A long entry begins on its own first line', 48, 80, 300),
        item('continuation', 'and continues onto another line', 62, 98, 300),
        item('pages', '12, 34', 525, 98, 45),
      ];
      if (heading === 'Contents') entries[3].text = '12';
      const original = document([page(entries)]);
      const reading = analyzeDocument(original);
      const semantic = heading === 'Contents' ? 'toc' : 'index';
      const entry = reading.blocks.find((block) => block.semantic === semantic)!;
      expect(entry).toBeDefined();
      expect(entry.kind).toBe('sourceRegion');
      expect(entry.sourceIds).toEqual(['title', 'continuation', 'pages']);
      owned(reading, original);
    },
  );

  it('distinguishes an untagged right-margin line-number sequence from an explicitly headed TOC', () => {
    const entries: SourceText[] = [];
    for (let index = 0; index < 3; index++)
      entries.push(
        item(
          `body-${index}`,
          `A long source line ${index + 1} contains continuous prose.`,
          48,
          80 + index * 24,
          450,
        ),
        item(`number-${index}`, String(index + 1), 535, 80 + index * 24, 12, 12),
      );
    const source = document([page(entries)]),
      reading = analyzeDocument(source);
    expect(reading.blocks.filter((block) => block.kind === 'lineNumber')).toHaveLength(3);
    expect(reading.blocks.some((block) => block.semantic === 'toc')).toBe(false);
    owned(reading, source);
    const contents = document([page([item('heading', 'Contents', 48, 30, 100, 18), ...entries])]),
      toc = analyzeDocument(contents);
    expect(toc.blocks.filter((block) => block.semantic === 'toc')).toHaveLength(3);
    expect(toc.blocks.some((block) => block.kind === 'lineNumber')).toBe(false);
    owned(toc, contents);
  });

  it('does not infer line labels from tagged numeric references or raised untagged superscripts', () => {
    const entries: SourceText[] = [],
      groups: SourceStructure[] = [];
    for (let index = 0; index < 3; index++) {
      entries.push(
        item(
          `body-${index}`,
          `A long source sentence ${index + 1} is followed by a reference.`,
          48,
          80 + index * 24,
          450,
        ),
        item(`ref-${index}`, String(index + 1), 535, 80 + index * 24, 7, 7),
      );
      groups.push(group(`reference-${index}`, 'Reference', [`ref-${index}`], index));
    }
    const tagged = document([page(entries, 1, groups)]),
      reading = analyzeDocument(tagged);
    expect(
      reading.blocks.some((block) => block.kind === 'lineNumber' || block.semantic === 'toc'),
    ).toBe(false);
    owned(reading, tagged);
    const raised = document([
        page(
          entries.map((entry) =>
            entry.id.startsWith('ref-') ? { ...entry, y: entry.y - 7 } : entry,
          ),
        ),
      ]),
      untagged = analyzeDocument(raised);
    expect(
      untagged.blocks.some((block) => block.kind === 'lineNumber' || block.semantic === 'toc'),
    ).toBe(false);
    owned(untagged, raised);
  });

  it('resolves split Reference and Note Lbl runs for 12 once despite separate notes 1 and 2', () => {
    const entries = [
      item('body', 'A reference points to the complete note number', 48, 70, 350),
      item('ref-1', '1', 400, 64, 4, 7, ['Reference', 'Lbl']),
      item('ref-2', '2', 404, 64, 4, 7, ['Reference', 'Lbl']),
    ];
    const groups = [group('reference', 'Reference', ['ref-1', 'ref-2'], 0)];
    for (const [index, value] of ['1', '2', '12'].entries()) {
      const labels =
        value === '12'
          ? [
              item('label-12-a', '1', 48, 730, 4, 8, ['Note', 'Lbl']),
              item('label-12-b', '2', 52, 730, 4, 8, ['Note', 'Lbl']),
            ]
          : [item(`label-${value}`, value, 48, 650 + index * 40, 8, 8, ['Note', 'Lbl'])];
      entries.push(
        ...labels,
        item(
          `note-${value}`,
          `The explanation for note ${value} is independently labeled.`,
          65,
          650 + index * 40,
          420,
          9,
          ['Note', 'P'],
        ),
      );
      groups.push(
        group(
          `note-group-${value}`,
          'Note',
          [...labels.map((entry) => entry.id), `note-${value}`],
          index * 2 + 1,
        ),
        group(
          `note-lbl-${value}`,
          'Lbl',
          labels.map((entry) => entry.id),
          index * 2 + 2,
          `note-group-${value}`,
        ),
      );
    }
    const source = document([page(entries, 1, groups)]),
      reading = analyzeDocument(source),
      note = reading.blocks.find((block) => block.noteLabel === '12')!;
    expect(note).toBeDefined();
    expect(reading.references).toHaveLength(1);
    expect(reading.references?.[0]).toMatchObject({
      source: { sourceId: 'ref-1' },
      targetBlockId: note.id,
    });
    owned(reading, source);
    const partial = document([
      page(
        entries.filter((entry) => !['label-12-a', 'label-12-b', 'note-12'].includes(entry.id)),
        1,
        groups.filter((entry) => !['note-group-12', 'note-lbl-12'].includes(entry.id)),
      ),
    ]);
    expect(analyzeDocument(partial).references).toEqual([]);
  });

  it('keeps each multiline Index P entry intact instead of splitting it into physical rows', () => {
    const entries = [
      item('term-a', 'A long index term begins here', 48, 80, 320),
      item('term-a-next', 'and continues on another line', 62, 98, 300),
      item('pages-a', '12, 18–20', 450, 98, 100),
      item('term-b', 'Another independent term', 48, 135, 260),
      item('pages-b', '24, 40', 480, 135, 70),
    ];
    const source = document([
      page(entries, 1, [
        group(
          'index',
          'Index',
          entries.map((entry) => entry.id),
          0,
        ),
        group('entry-a', 'P', ['term-a', 'term-a-next', 'pages-a'], 1, 'index'),
        group('entry-b', 'P', ['term-b', 'pages-b'], 2, 'index'),
      ]),
    ]);
    const reading = analyzeDocument(source),
      index = reading.blocks.filter((block) => block.semantic === 'index');
    expect(index).toHaveLength(2);
    expect(index[0].sourceIds).toEqual(['term-a', 'term-a-next', 'pages-a']);
    expect(index[1].sourceIds).toEqual(['term-b', 'pages-b']);
    owned(reading, source);
  });

  it('combines separate TOC P title, hanging continuation and page-number siblings into one entry', () => {
    const entries = [
      item('title-a', 'A long chapter title starts here', 48, 80, 300),
      item('continuation-a', 'and continues with more words', 62, 98, 300),
      item('page-a', '12', 525, 98, 16),
      item('title-b', 'The next independent chapter', 48, 135, 300),
      item('page-b', '24', 525, 135, 16),
    ];
    const source = document([
      page(entries, 1, [
        group(
          'toc',
          'TOC',
          entries.map((entry) => entry.id),
          0,
        ),
        ...entries.map((entry, index) => group(`p-${entry.id}`, 'P', [entry.id], index + 1, 'toc')),
      ]),
    ]);
    const reading = analyzeDocument(source),
      contents = reading.blocks.filter((block) => block.semantic === 'toc');
    expect(contents).toHaveLength(2);
    expect(contents[0].sourceIds).toEqual(['title-a', 'continuation-a', 'page-a']);
    expect(contents[1].sourceIds).toEqual(['title-b', 'page-b']);
    owned(reading, source);
  });

  it('keeps a tagged TOCI together when its title and page number use different P children', () => {
    const entries = [
      item('title', 'Introduction', 48, 80, 180),
      item('dots', '................', 240, 80, 200),
      item('page', '12', 520, 80, 14),
    ];
    const source = document([
      page(entries, 1, [
        group('toc', 'TOC', ['title', 'dots', 'page'], 0),
        group('entry', 'TOCI', ['title', 'dots', 'page'], 1, 'toc'),
        group('title-p', 'P', ['title'], 2, 'entry'),
        group('page-p', 'P', ['page'], 3, 'entry'),
      ]),
    ]);
    const reading = analyzeDocument(source);
    expect(reading.blocks).toHaveLength(1);
    expect(reading.blocks[0]).toMatchObject({
      kind: 'sourceRegion',
      semantic: 'toc',
      sourceIds: ['title', 'dots', 'page'],
    });
    owned(reading, source);
  });

  it('recognizes untagged contents rows before distant page numbers become a second column', () => {
    const entries = [item('heading', 'Contents', 48, 30, 100, 18)];
    for (let index = 0; index < 3; index++)
      entries.push(
        item(`title-${index}`, `Chapter ${index + 1}: A useful title`, 48, 90 + index * 28, 260),
        item(`number-${index}`, `${index * 20 + 1}`, 525, 90 + index * 28, 20),
      );
    const source = document([page(entries)]),
      reading = analyzeDocument(source);
    const contents = reading.blocks.filter((block) => block.semantic === 'toc');
    expect(contents).toHaveLength(3);
    for (let index = 0; index < 3; index++)
      expect(contents[index].sourceIds).toEqual([`title-${index}`, `number-${index}`]);
    expect(reading.blocks.some((block) => block.kind === 'lineNumber')).toBe(false);
    owned(reading, source);
  });

  it('keeps note labels and wrapped text together and links a tagged superscript without treating it as math', () => {
    const entries = [
      item('body', 'The surrounding paragraph contains a reference', 48, 70, 350),
      item('ref', '1', 400, 64, 5, 7, ['P', 'Reference', 'Lbl']),
      item('note-label', '1', 48, 692, 5, 7, ['Note', 'Lbl']),
      item(
        'note-text',
        'The first line of this footnote explains the reference.',
        59,
        695,
        430,
        9,
        ['Note', 'P'],
      ),
      item('note-next', 'The next line belongs to the same footnote.', 59, 709, 350, 9, [
        'Note',
        'P',
      ]),
    ];
    const source = document([
      page(entries, 1, [
        group('reference', 'Reference', ['ref'], 0),
        group('note', 'Note', ['note-label', 'note-text', 'note-next'], 1),
      ]),
    ]);
    const reading = analyzeDocument(source),
      note = reading.blocks.find((block) => block.semantic === 'note')!;
    expect(note).toMatchObject({ kind: 'footnote', noteLabel: '1', keepTogether: true });
    expect(note.sourceIds).toEqual(['note-label', 'note-text', 'note-next']);
    const paragraph = reading.blocks.find((block) => block.sourceIds.includes('body'))!;
    expect(paragraph.kind).toBe('paragraph');
    expect(paragraph.sourceIds).toContain('ref');
    expect(reading.references).toEqual([
      {
        id: `ref:${note.id}`,
        source: { blockId: paragraph.id, sourceId: 'ref' },
        targetBlockId: note.id,
      },
    ]);
    owned(reading, source);
  });

  it('groups an index term with all referenced page numbers', () => {
    const source = document([
      page([
        item('heading', 'Index', 48, 30, 100, 18),
        item('term', 'Document structure', 48, 90, 210),
        item('refs', '12, 24–26, 90', 390, 90, 140),
      ]),
    ]);
    const reading = analyzeDocument(source),
      entry = reading.blocks.find((block) => block.semantic === 'index');
    expect(entry).toMatchObject({ kind: 'sourceRegion', sourceIds: ['term', 'refs'] });
    owned(reading, source);
  });

  it('resolves a unique endnote on a later page using an explicit Notes section', () => {
    const first = page(
      [
        item('body', 'A paragraph that has a later endnote', 48, 70, 330),
        item('ref', '2', 380, 64, 5, 7, ['Reference', 'Lbl']),
      ],
      1,
      [group('reference', 'Reference', ['ref'], 0)],
    );
    const second = page(
      [
        item('heading', 'Endnotes', 48, 30, 140, 18),
        item('label', '2', 48, 90, 8, 10),
        item('note', 'This explanation lives at the end of the document.', 62, 90, 440, 12),
      ],
      2,
    );
    const source = document([first, second]),
      reading = analyzeDocument(source),
      note = reading.blocks.find((block) => block.semantic === 'note')!;
    expect(note.noteLabel).toBe('2');
    expect(reading.references?.[0]?.targetBlockId).toBe(note.id);
    owned(reading, source);
  });

  it('anchors same-size margin line numbers to original body-line starts without adding paragraph breaks', () => {
    const entries: SourceText[] = [];
    for (let index = 0; index < 3; index++)
      entries.push(
        item(`number-${index}`, String(10 + index), 18, 80 + index * 20, 15, 12),
        item(
          `body-${index}`,
          `The text on original source line ${index + 1} continues naturally.`,
          50,
          80 + index * 20,
          450,
        ),
      );
    const source = document([page(entries)]),
      reading = analyzeDocument(source),
      numbers = reading.blocks.filter((block) => block.kind === 'lineNumber');
    expect(numbers).toHaveLength(3);
    for (let index = 0; index < 3; index++) {
      expect(numbers[index].text).toBe(String(10 + index));
      expect(numbers[index].anchor?.sourceId).toBe(`body-${index}`);
      const body = reading.blocks.find((block) => block.id === numbers[index].anchor?.blockId)!;
      expect(body.sourceIds).not.toContain(`number-${index}`);
      expect(body.sourceSpans?.some((span) => span.sourceId === `body-${index}`)).toBe(true);
    }
    owned(reading, source);
  });

  it('does not interpret numbered lists or table-cell numbers as line numbers', () => {
    const entries: SourceText[] = [];
    for (let index = 0; index < 3; index++)
      entries.push(
        item(
          `list-${index}`,
          `${index + 1}. A numbered list item remains ordinary content.`,
          48,
          70 + index * 25,
          450,
        ),
        item(`cell-${index}`, String(index + 1), 18, 250 + index * 25, 10, 8, [
          'Table',
          'TR',
          'TD',
        ]),
        item(
          `value-${index}`,
          `This label belongs to a table row ${index + 1}.`,
          50,
          250 + index * 25,
          400,
        ),
      );
    const original = page(entries);
    original.graphicRegions = [{ x: 10, y: 240, width: 550, height: 85 }];
    const source = document([original]),
      reading = analyzeDocument(source);
    expect(reading.blocks.some((block) => block.kind === 'lineNumber')).toBe(false);
    owned(reading, source);
  });

  it('anchors numbers to preserved objects when no text run starts that row', () => {
    const original = page([
      item('n1', '5', 18, 80, 8, 8),
      item('n2', '10', 18, 180, 12, 8),
      item('n3', '15', 18, 280, 12, 8),
    ]);
    original.graphicRegions = [80, 180, 280].map((y) => ({ x: 50, y, width: 400, height: 45 }));
    const source = document([original]),
      reading = analyzeDocument(source),
      numbers = reading.blocks.filter((block) => block.kind === 'lineNumber');
    expect(numbers).toHaveLength(3);
    for (const number of numbers) {
      expect(number.anchor?.sourceId).toBeUndefined();
      expect(reading.blocks.find((block) => block.id === number.anchor?.blockId)?.kind).toBe(
        'sourceRegion',
      );
    }
    owned(reading, source);
  });

  it('keeps numbers inside a preserved graphic there instead of painting another copy', () => {
    const original = page([
      item('n1', '1', 18, 80, 8, 8),
      item('n2', '2', 18, 100, 8, 8),
      item('n3', '3', 18, 120, 8, 8),
      item('body1', 'Content belongs to the original object.', 50, 80),
      item('body2', 'More content in this original object.', 50, 100),
      item('body3', 'Its final original line of content.', 50, 120),
    ]);
    original.graphicRegions = [{ x: 10, y: 65, width: 550, height: 90 }];
    const source = document([original]),
      reading = analyzeDocument(source);
    expect(reading.blocks.some((block) => block.kind === 'lineNumber')).toBe(false);
    owned(reading, source);
  });

  it('does not invent a target when the same endnote label is ambiguous across later pages', () => {
    const first = page(
      [
        item('body', 'This reference cannot be resolved confidently.', 48, 70, 350),
        item('ref', '1', 400, 64, 5, 7, ['Reference']),
      ],
      1,
      [group('refgroup', 'Reference', ['ref'], 0)],
    );
    const notes = [2, 3].map((number) =>
      page(
        [
          item(`label-${number}`, '1', 48, 700, 5, 8),
          item(
            `note-${number}`,
            'A repeated note label has a different meaning here.',
            60,
            700,
            430,
            9,
          ),
        ],
        number,
        [group(`note-${number}`, 'Note', [`label-${number}`, `note-${number}`], 0)],
      ),
    );
    const source = document([first, ...notes]),
      reading = analyzeDocument(source);
    expect(reading.references).toEqual([]);
    owned(reading, source);
  });

  it('preserves a complex multicolumn tagged note instead of reordering its fragments', () => {
    const entries = [
      item('label', '1', 48, 600, 8, 9),
      item('left-top', 'The first column starts here.', 62, 600, 180, 9),
      item('left-bottom', 'It continues down the first column.', 62, 620, 180, 9),
      item('right-top', 'The second column begins at its top.', 330, 600, 220, 9),
    ];
    const source = document([
        page(entries, 1, [
          group(
            'note',
            'Note',
            entries.map((entry) => entry.id),
            0,
          ),
        ]),
      ]),
      reading = analyzeDocument(source);
    expect(reading.blocks[0]).toMatchObject({
      kind: 'sourceRegion',
      semantic: 'note',
      noteLabel: '1',
    });
    owned(reading, source);
  });
});
