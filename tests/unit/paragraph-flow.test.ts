import { describe, expect, it } from 'vitest';
import { analyzeDocument } from '../../src/core/analyze';
import { persistentColumnBands } from '../../src/core/column-bands';
import type { SourceDocument, SourcePage, SourceText } from '../../src/core/model';

function text(
  id: string,
  value: string,
  x: number,
  y: number,
  width: number,
  fontSize = 9,
): SourceText {
  return {
    id,
    text: value,
    x,
    y,
    width,
    height: fontSize,
    fontSize,
    baselineY: y + fontSize * 0.75,
    fontName: 'serif',
    hasEOL: true,
  };
}

function analyze(items: SourceText[]) {
  const source: SourceDocument = {
    schemaVersion: 1,
    hash: 'paragraph-flow',
    name: 'paragraph-flow.pdf',
    pageCount: 1,
    engine: 'test',
    pages: [
      {
        number: 1,
        width: 610,
        height: 800,
        rotation: 0,
        items,
        graphicRegions: [],
        warnings: [],
      },
    ],
  };
  const blocks = analyzeDocument(source).blocks;
  const owners = blocks.flatMap((block) => block.sourceIds);
  expect(owners).toHaveLength(items.length);
  expect(new Set(owners).size).toBe(items.length);
  return blocks;
}

function bodyColumns() {
  return Array.from({ length: 8 }, (_, row) => [
    text(
      `body-left-${row}`,
      `Left body row ${row} continues with ordinary prose`,
      60,
      240 + row * 14,
      236,
      10,
    ),
    text(
      `body-right-${row}`,
      `Right body row ${row} continues with ordinary prose`,
      314,
      240 + row * 14,
      236,
      10,
    ),
  ]).flat();
}

function summary() {
  return [
    ...Array.from({ length: 6 }, (_, row) =>
      text(
        `summary-${row}`,
        `The wider summary row ${row} continues with ordinary prose`,
        72,
        100 + row * 12,
        370,
      ),
    ),
    text('summary-tail', 'a short ending.', 72, 172, 78),
  ];
}

describe('paragraph flow across changes of column layout', () => {
  it('drops a chart-derived gutter after its labels are preserved while retaining the section boundary', () => {
    const remaining = summary();
    const chartLabels = Array.from({ length: 6 }, (_, row) => [
      text(`chart-left-${row}`, 'A description of the first chart column', 72, 20 + row * 10, 140),
      text(`chart-right-${row}`, 'A description of the next chart column', 260, 20 + row * 10, 150),
    ]).flat();
    const page: SourcePage = {
      number: 1,
      width: 610,
      height: 800,
      rotation: 0,
      items: [...chartLabels, ...remaining],
      graphicRegions: [],
      warnings: [],
    };
    const initial = [{ top: 10, bottom: Infinity, items: page.items, gutter: 250 }];
    expect(persistentColumnBands(page, remaining, [], initial)).toEqual([
      { top: 10, bottom: Infinity, items: remaining, gutter: undefined },
    ]);
  });

  it('keeps a wide summary beside a short sidebar together before ordinary columns begin', () => {
    const blocks = analyze([
      ...summary(),
      ...Array.from({ length: 3 }, (_, row) =>
        text(`sidebar-${row}`, `Publication metadata row ${row}`, 460, 100 + row * 12, 86),
      ),
      ...bodyColumns(),
    ]);
    const summaryBlock = blocks.find((block) => block.sourceIds.includes('summary-0'))!;
    expect(summaryBlock.sourceIds).toEqual([
      ...Array.from({ length: 6 }, (_, row) => `summary-${row}`),
      'summary-tail',
    ]);
    expect(summaryBlock.text).toContain('row 5 continues with ordinary prose a short ending.');
    expect(summaryBlock.rawText?.split('\n')).toHaveLength(7);
    const order = blocks.flatMap((block) => block.sourceIds);
    expect(order.indexOf('summary-tail')).toBeLessThan(order.indexOf('sidebar-0'));
    expect(order.indexOf('sidebar-2')).toBeLessThan(order.indexOf('body-left-0'));
    expect(order.indexOf('body-left-7')).toBeLessThan(order.indexOf('body-right-0'));
  });

  it('keeps an unruled single-column summary and its short last line above two columns', () => {
    const blocks = analyze([...summary(), ...bodyColumns()]);
    const summaryBlock = blocks.find((block) => block.sourceIds.includes('summary-0'))!;
    expect(summaryBlock.sourceIds).toEqual([
      ...Array.from({ length: 6 }, (_, row) => `summary-${row}`),
      'summary-tail',
    ]);
    expect(summaryBlock.text).not.toContain('\n');
    const order = blocks.flatMap((block) => block.sourceIds);
    expect(order.indexOf('summary-tail')).toBeLessThan(order.indexOf('body-left-0'));
    expect(order.indexOf('body-left-7')).toBeLessThan(order.indexOf('body-right-0'));
  });

  it('does not split a full-width title at ordinary word spaces near the body gutter', () => {
    const blocks = analyze([
      text('title-start', 'A wide title with its original text', 60, 50, 285, 14),
      text('title-middle', 'and the remaining', 348, 50, 110, 14),
      text('title-end', 'words', 461, 50, 43, 14),
      ...bodyColumns(),
    ]);
    expect(blocks.find((block) => block.sourceIds.includes('title-start'))).toMatchObject({
      kind: 'heading',
      sourceIds: ['title-start', 'title-middle', 'title-end'],
      text: 'A wide title with its original text and the remaining words',
    });
  });
});
