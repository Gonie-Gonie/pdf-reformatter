import { describe, expect, it } from 'vitest';
import { analyzeDocument } from '../../src/core/analyze';
import { analyzePageSemantics } from '../../src/core/semantics';
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
  it('preserves tagged table cells and rules without absorbing its caption or following prose', () => {
    const cells = [
      item('head-left', 'Model', 48, 100, 120),
      item('head-right', 'Configuration', 330, 100, 220),
      item('left-1', 'Ridge', 48, 124, 120),
      item('right-1', 'Standardized inputs', 330, 124, 220),
      item('left-2', 'Random forest', 48, 148, 120),
      item('right-2', 'Three hundred trees', 330, 148, 220),
    ];
    const original = page(
      [
        item('caption', 'Table 1. Forecasting models and configurations.', 48, 70, 500),
        ...cells,
        item('untagged-cell', 'Supplemental cell label', 330, 136, 180),
        item('after', 'Following prose must remain available for reflow.', 48, 200, 500),
      ],
      1,
      [
        group(
          'table',
          'Table',
          cells.map((entry) => entry.id),
          0,
        ),
      ],
    );
    original.graphicRegions = [96, 162].map((y) => ({ x: 45, y, width: 510, height: 2 }));
    const source = document([original]),
      reading = analyzeDocument(source),
      table = reading.blocks.find((block) => block.id === 'p1:table:table')!;
    expect(table.kind).toBe('sourceRegion');
    expect(table.sourceIds).toHaveLength(7);
    expect(table.sourceIds).toEqual(expect.arrayContaining(cells.map((entry) => entry.id)));
    expect(table.sourceIds).toContain('untagged-cell');
    expect(table.sourceIds).not.toContain('caption');
    expect(table.sourceIds).not.toContain('after');
    expect(table.rect.y).toBe(96);
    expect(table.rect.y + table.rect.height).toBe(164);
    expect(reading.blocks.find((block) => block.sourceIds.includes('after'))?.kind).toBe(
      'paragraph',
    );
    owned(reading, source);
  });

  it('claims a nested table once and keeps an adjacent diagram outside its crop', () => {
    const cells = [
      item('one', 'Header', 48, 100, 120),
      item('two', 'Value', 220, 100, 100),
      item('three', 'Entry', 48, 124, 120),
      item('four', 'Result', 220, 124, 100),
    ];
    const original = page(cells, 1, [
      group(
        'outer',
        'Table',
        cells.map((entry) => entry.id),
        0,
      ),
      group('inner', 'Table', ['two', 'four'], 1, 'outer'),
    ]);
    original.graphicRegions = [{ x: 330, y: 95, width: 200, height: 140 }];
    const semantic = analyzePageSemantics(original);
    expect(semantic.blocks).toHaveLength(1);
    expect(semantic.blocks[0].sourceIds).toHaveLength(4);
    expect(semantic.blocks[0].rect.x + semantic.blocks[0].rect.width).toBeLessThanOrEqual(330);
    expect(new Set(semantic.blocks[0].sourceIds).size).toBe(4);
  });

  it('keeps a table inside a tagged note in the existing compound note', () => {
    const entries = [
      item('label', '1', 48, 600, 8, 9),
      item('heading', 'A table in a note.', 62, 600, 180, 9),
      item('left', 'Label', 62, 620, 100, 9),
      item('right', 'Value', 330, 620, 100, 9),
    ];
    const source = document([
        page(entries, 1, [
          group(
            'note',
            'Note',
            entries.map((entry) => entry.id),
            0,
          ),
          group('table', 'Table', ['left', 'right'], 1, 'note'),
        ]),
      ]),
      reading = analyzeDocument(source);
    expect(reading.blocks).toHaveLength(1);
    expect(reading.blocks[0]).toMatchObject({ kind: 'sourceRegion', semantic: 'note' });
    owned(reading, source);
  });

  it('does not infer authoritative tables from untagged tabular-looking text', () => {
    const original = page([
      item('left', 'A paragraph begins in the left column.', 48, 100, 220),
      item('right', 'An independent paragraph begins on the right.', 330, 100, 220),
    ]);
    expect(
      analyzePageSemantics(original).blocks.some((block) => block.id.includes(':table:')),
    ).toBe(false);
  });

  it('uses a standalone caption, rules and repeated small cell columns to preserve an untagged table', () => {
    const cells = [0, 1, 2].flatMap((index) => [
      item(`left-${index}`, `Model ${index}`, 48, 100 + index * 20, 120, 8),
      item(`right-${index}`, `Configuration ${index}`, 330, 100 + index * 20, 220, 8),
    ]);
    const original = page([
      item('body', 'An ordinary paragraph establishes the document body size.', 48, 35, 500),
      item('caption', 'Table 1', 48, 70, 40, 10),
      item('description', 'Model configurations.', 48, 84, 180, 10),
      ...cells,
      item('following', 'The following paragraph still flows independently.', 48, 200, 500),
    ]);
    original.graphicRegions = [98, 160].map((y) => ({ x: 45, y, width: 510, height: 2 }));
    const semantic = analyzePageSemantics(original),
      table = semantic.blocks.find((block) => block.id.includes(':table:ruled:'))!;
    expect(table).toBeDefined();
    expect(table.sourceIds).toEqual(expect.arrayContaining(cells.map((entry) => entry.id)));
    expect(table.sourceIds).toHaveLength(6);
    expect(table.sourceIds).not.toEqual(
      expect.arrayContaining(['caption', 'description', 'following']),
    );
    const source = document([original]),
      reading = analyzeDocument(source);
    owned(reading, source);
  });

  it.each(['inline reference', 'no rules', 'unstable columns'])(
    'leaves an ambiguous untagged table candidate unchanged: %s',
    (variant) => {
      const original = page([
        item(
          'body-early',
          'Continuous prose above the table keeps its ordinary font size.',
          48,
          5,
          500,
        ),
        item(
          'body-middle',
          'More ordinary prose supplies independent body-font evidence.',
          48,
          20,
          500,
        ),
        item('body', 'An ordinary paragraph establishes the document body size.', 48, 35, 500),
        item('caption', 'Table 1', 48, 70, 40, 10),
        ...[0, 1, 2].flatMap((index) => [
          item(`left-${index}`, `Model ${index}`, 48, 100 + index * 20, 120, 8),
          item(
            `right-${index}`,
            `Configuration ${index}`,
            variant === 'unstable columns' ? 330 + index * 35 : 330,
            100 + index * 20,
            120,
            8,
          ),
        ]),
      ]);
      if (variant === 'inline reference')
        original.items.push(
          item('continuation', 'is discussed in this paragraph.', 91, 70, 250, 10),
        );
      if (variant !== 'no rules')
        original.graphicRegions = [98, 160].map((y) => ({ x: 45, y, width: 510, height: 2 }));
      expect(
        analyzePageSemantics(original).blocks.some((block) => block.id.includes(':table:ruled:')),
      ).toBe(false);
    },
  );

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
