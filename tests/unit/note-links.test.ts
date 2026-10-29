import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber } from 'pdf-lib';
import { addNoteLinks } from '../../src/adapters/pdf/note-links';
import { DEFAULT_CONFIG } from '../../src/core/config';
import type { LayoutDocument, ReadingBlock, ReadingDocument } from '../../src/core/model';

const measure = (text: string, size: number) => (text.length * size) / 2;

async function fixture() {
  const output = await PDFDocument.create();
  output.addPage([400, 600]);
  output.addPage([400, 600]);
  const source: ReadingBlock = {
    id: 'body',
    kind: 'paragraph',
    sourcePage: 1,
    sourceIds: ['body-text', 'reference', 'following'],
    rect: { x: 20, y: 40, width: 300, height: 14 },
    text: 'Body 1 follows.',
    rawText: 'Body 1 follows.',
    fontSize: 12,
    confidence: 'high',
    sourceSpans: [
      { sourceId: 'body-text', start: 0, end: 4, rect: { x: 20, y: 40, width: 24, height: 14 } },
      { sourceId: 'reference', start: 4, end: 5, rect: { x: 44, y: 38, width: 6, height: 8 } },
      { sourceId: 'following', start: 5, end: 13, rect: { x: 50, y: 40, width: 100, height: 14 } },
    ],
  };
  const note: ReadingBlock = {
    id: 'note',
    kind: 'footnote',
    semantic: 'note',
    noteLabel: '1',
    sourcePage: 2,
    sourceIds: ['note-label', 'note-body'],
    rect: { x: 20, y: 300, width: 250, height: 100 },
    text: '1 Note text.',
    rawText: '1 Note text.',
    fontSize: 10,
    confidence: 'high',
    sourceSpans: [
      { sourceId: 'note-label', start: 0, end: 1, rect: { x: 20, y: 300, width: 6, height: 10 } },
      {
        sourceId: 'note-body',
        start: 1,
        end: 10,
        rect: { x: 26, y: 300, width: 244, height: 100 },
      },
    ],
  };
  const reading: ReadingDocument = {
    schemaVersion: 1,
    sourceHash: 'test',
    blocks: [source, note],
    warnings: [],
    references: [
      {
        id: 'ref-1',
        source: { blockId: source.id, sourceId: 'reference' },
        targetBlockId: note.id,
      },
    ],
  };
  const layout: LayoutDocument = {
    config: { ...DEFAULT_CONFIG, pageWidthPt: 400, pageHeightPt: 600 },
    warnings: [],
    pages: [
      {
        number: 1,
        sourcePages: [1],
        placements: [
          {
            type: 'text',
            blockId: source.id,
            sourcePage: 1,
            text: source.text,
            fontSize: 12,
            textStart: 0,
            textEnd: 13,
            x: 40,
            y: 60,
            width: 200,
            height: 15,
          },
        ],
      },
      {
        number: 2,
        sourcePages: [2],
        placements: [
          {
            type: 'text',
            blockId: note.id,
            sourcePage: 2,
            text: note.text,
            fontSize: 10,
            textStart: 0,
            textEnd: 10,
            x: 40,
            y: 70,
            width: 200,
            height: 14,
          },
        ],
      },
    ],
  };
  return { output, reading, layout };
}

function annotation(output: PDFDocument, page: number, index = 0): PDFDict {
  return output
    .getPage(page - 1)
    .node.Annots()!
    .lookup(index, PDFDict);
}

function numbers(array: PDFArray): number[] {
  return Array.from({ length: array.size() }, (_, index) =>
    array.lookup(index, PDFNumber).asNumber(),
  );
}

describe('internal note navigation', () => {
  it('adds a reference link and a narrow note-label backlink with PDF coordinates', async () => {
    const { output, reading, layout } = await fixture();
    addNoteLinks(output, reading, layout, measure);

    const forward = annotation(output, 1);
    const backward = annotation(output, 2);
    expect(forward.lookup(PDFName.of('Subtype'), PDFName).asString()).toBe('/Link');
    const destination = forward.lookup(PDFName.of('Dest'), PDFArray);
    expect(destination.get(0)).toBe(output.getPage(1).ref);
    expect(destination.lookup(1, PDFName).asString()).toBe('/XYZ');
    expect(destination.lookup(2, PDFNumber).asNumber()).toBe(40);
    expect(destination.lookup(3, PDFNumber).asNumber()).toBe(530);
    expect(destination.get(4)?.toString()).toBe('null');
    const returnDestination = backward.lookup(PDFName.of('Dest'), PDFArray);
    expect(returnDestination.get(0)).toBe(output.getPage(0).ref);
    expect(returnDestination.lookup(3, PDFNumber).asNumber()).toBe(540);
    const referenceRect = numbers(forward.lookup(PDFName.of('Rect'), PDFArray));
    const labelRect = numbers(backward.lookup(PDFName.of('Rect'), PDFArray));
    expect(referenceRect[2] - referenceRect[0]).toBeLessThan(20);
    expect(labelRect[2] - labelRect[0]).toBeLessThan(20);
    expect(labelRect[3] - labelRect[1]).toBeLessThanOrEqual(14);
    expect(forward.has(PDFName.of('A'))).toBe(false);
  });

  it('links multiple references but adds one backlink to the first reference per note', async () => {
    const { output, reading, layout } = await fixture();
    const second = {
      ...reading.blocks[0],
      id: 'second-body',
      text: '1 Another reference.',
      rawText: '1 Another reference.',
      sourceIds: ['second-reference'],
      sourceSpans: [
        {
          sourceId: 'second-reference',
          start: 0,
          end: 1,
          rect: { x: 20, y: 100, width: 6, height: 8 },
        },
      ],
    };
    reading.blocks.push(second);
    reading.references!.push({
      id: 'ref-2',
      source: { blockId: second.id, sourceId: 'second-reference' },
      targetBlockId: 'note',
    });
    reading.references!.push({ ...reading.references![0], id: 'duplicate' });
    layout.pages[0].placements.push({
      type: 'text',
      blockId: second.id,
      sourcePage: 1,
      text: second.text,
      fontSize: 12,
      textStart: 0,
      textEnd: 13,
      x: 40,
      y: 100,
      width: 200,
      height: 15,
    });
    addNoteLinks(output, reading, layout, measure);

    expect(output.getPage(0).node.Annots()!.size()).toBe(2);
    expect(output.getPage(1).node.Annots()!.size()).toBe(1);
    const destination = annotation(output, 2).lookup(PDFName.of('Dest'), PDFArray);
    expect(destination.lookup(3, PDFNumber).asNumber()).toBe(540);
  });

  it('does not link excluded notes, out-of-scope references, or decoration-only placements', async () => {
    for (const missing of ['note', 'reference', 'decoration']) {
      const { output, reading, layout } = await fixture();
      if (missing === 'note') layout.pages[1].placements = [];
      if (missing === 'reference')
        reading.blocks = reading.blocks.filter((block) => block.id !== 'body');
      if (missing === 'decoration') {
        const placement = layout.pages[0].placements[0];
        if (placement.type === 'text') placement.decoration = 'lineNumber';
      }
      addNoteLinks(output, reading, layout, measure);
      expect(output.getPage(0).node.Annots()).toBeUndefined();
      expect(output.getPage(1).node.Annots()).toBeUndefined();
    }
  });

  it('limits preserved-note backlinks to the original label rather than the note image', async () => {
    const { output, reading, layout } = await fixture();
    const note = reading.blocks[1];
    note.kind = 'sourceRegion';
    layout.pages[1].placements = [
      {
        type: 'region',
        blockId: note.id,
        sourcePage: 2,
        sourceRect: note.rect,
        x: 40,
        y: 70,
        width: 250,
        height: 100,
      },
    ];
    addNoteLinks(output, reading, layout, measure);

    const rect = numbers(annotation(output, 2).lookup(PDFName.of('Rect'), PDFArray));
    expect(rect[2] - rect[0]).toBeLessThan(20);
    expect(rect[3] - rect[1]).toBeLessThanOrEqual(12.5);
  });

  it('ignores invalid destination geometry without creating dangling annotations', async () => {
    const { output, reading, layout } = await fixture();
    layout.pages[1].placements[0].y = Number.NaN;
    addNoteLinks(output, reading, layout, measure);
    expect(output.getPage(0).node.Annots()).toBeUndefined();
    expect(output.getPage(1).node.Annots()).toBeUndefined();
  });
});
