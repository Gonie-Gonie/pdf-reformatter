import { describe, expect, it } from 'vitest';
import { bionicBlock, bionicSegments } from '../../src/core/bionic-reading';
import { DEFAULT_CONFIG } from '../../src/core/config';
import { layoutDocument } from '../../src/core/layout';
import type { MeasureText } from '../../src/core/layout';
import type {
  LayoutConfig,
  ReadingBlock,
  ReadingDocument,
  TextPlacement,
} from '../../src/core/model';

const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
const normalized = (text: string) => text.normalize('NFKC').replace(/[\s\u00ad]/gu, '');
const config: LayoutConfig = {
  ...DEFAULT_CONFIG,
  pageWidthPt: 240,
  pageHeightPt: 500,
  marginTopPt: 16,
  marginBottomPt: 16,
  marginLeftPt: 12,
  marginRightPt: 12,
  fontSizePt: 12,
  bionicReading: true,
};
const measure: MeasureText = (text, size, bionic) =>
  [...text.replace(/\u00ad/gu, '-')].length * size * (bionic ? 0.85 : 0.5);

function block(id: string, text: string, changes: Partial<ReadingBlock> = {}): ReadingBlock {
  return {
    id,
    kind: 'paragraph',
    sourcePage: 1,
    sourceIds: [id],
    rect: { x: 40, y: 100, width: 320, height: 24 },
    rawText: text,
    text,
    fontSize: 12,
    confidence: 'high',
    ...changes,
  };
}

function document(blocks: ReadingBlock[]): ReadingDocument {
  return { schemaVersion: 1, sourceHash: 'bionic', blocks, warnings: [] };
}

function textPlacements(layout: ReturnType<typeof layoutDocument>): TextPlacement[] {
  return layout.pages
    .flatMap((page) => page.placements)
    .filter((placement): placement is TextPlacement => placement.type === 'text');
}

describe('open source bionic word fixation', () => {
  it('returns no formatting for empty text', () => {
    expect(bionicSegments('')).toEqual([]);
  });

  it.each([
    '<b>literal</b> &amp; <script>reading()</script>',
    '  Reading\talgorithms\r\n한국어  ',
    'read\u00ading co\u00adoperation',
    '\ue000\ue001reading\ue000\ue002 \ue000\ue000\ue001literal\ue000\ue000\ue002',
    'e\u0301lan 👩🏽‍🚀 𝒜stral 🇰🇷 가\u0301나다 👨‍👩‍👧‍👦',
  ])('retains literal text and whole graphemes: %j', (text) => {
    const segments = bionicSegments(text);
    expect(segments.map((segment) => segment.text).join('')).toBe(text);
    const boundaries = new Set([
      0,
      ...[...segmenter.segment(text)].map((cluster) => cluster.index + cluster.segment.length),
    ]);
    let offset = 0;
    for (const segment of segments) {
      expect(segment.text.length).toBeGreaterThan(0);
      offset += segment.text.length;
      expect(boundaries.has(offset)).toBe(true);
    }
  });

  it('uses fixation-point 3 prefixes for English words and Korean syllables', () => {
    expect(bionicSegments('Reading beautiful algorithms')).toEqual([
      { text: 'Read', bold: true },
      { text: 'ing ', bold: false },
      { text: 'beaut', bold: true },
      { text: 'iful ', bold: false },
      { text: 'algor', bold: true },
      { text: 'ithms', bold: false },
    ]);
    expect(bionicSegments('한국어 문장을 읽습니다')).toEqual([
      { text: '한', bold: true },
      { text: '국어 ', bold: false },
      { text: '문', bold: true },
      { text: '장을 ', bold: false },
      { text: '읽습', bold: true },
      { text: '니다', bold: false },
    ]);
  });

  it('does not emphasize numeric values and punctuation', () => {
    const text = '123 123.45 2026-11-12 (42%) + − /';
    expect(bionicSegments(text)).toEqual([{ text, bold: false }]);
  });

  it('selects flowing prose while excluding headings, furniture and preserved semantics', () => {
    for (const kind of ['paragraph', 'list', 'footnote', 'reference'] as const)
      expect(bionicBlock(block(kind, 'Ordinary reading text', { kind }))).toBe(true);
    expect(bionicBlock(block('note', 'A footnote explanation.', { semantic: 'note' }))).toBe(true);
    for (const kind of ['heading', 'caption', 'sourceRegion', 'lineNumber'] as const)
      expect(bionicBlock(block(kind, 'Ordinary reading text', { kind }))).toBe(false);
    for (const semantic of ['toc', 'index', 'table'] as const)
      expect(bionicBlock(block(semantic, 'Ordinary reading text', { semantic }))).toBe(false);
    for (const running of ['header', 'footer'] as const)
      expect(bionicBlock(block(running, 'Ordinary reading text', { running }))).toBe(false);
  });
});

describe('bionic text layout', () => {
  it('measures wider emphasized text before wrapping and keeps every line inside its margins', () => {
    const body = block(
      'body',
      'Reading science with clear words and useful ideas improves the flow of this complete paragraph. '.repeat(
        4,
      ),
    );
    const reading = document([body]);
    const original = JSON.stringify(reading);
    const requested: (boolean | undefined)[] = [];
    const observing: MeasureText = (text, size, bionic) => {
      requested.push(bionic);
      return measure(text, size, bionic);
    };
    const on = layoutDocument(reading, config, observing);
    const off = layoutDocument(reading, { ...config, bionicReading: false }, measure);
    const lines = textPlacements(on);
    expect(requested).toContain(true);
    expect(lines.length).toBeGreaterThan(textPlacements(off).length);
    expect(lines.every((line) => line.bionic === true)).toBe(true);
    for (const line of lines) {
      expect(line.x).toBeGreaterThanOrEqual(config.marginLeftPt - 0.001);
      expect(line.x + line.width).toBeLessThanOrEqual(
        config.pageWidthPt - config.marginRightPt + 0.001,
      );
      expect(line.y + line.height).toBeLessThanOrEqual(
        config.pageHeightPt - config.marginBottomPt + 0.001,
      );
    }
    expect(normalized(lines.map((line) => line.text).join(''))).toBe(normalized(body.text));
    expect(JSON.stringify(reading)).toBe(original);
  });

  it('keeps opt-out placements identical to the existing two-argument measurement path', () => {
    const reading = document([
      block('body', 'Reading familiar material with unchanged word spacing. '.repeat(4)),
    ]);
    const off = { ...config, bionicReading: false };
    const plain = layoutDocument(reading, off, (text, size) => measure(text, size));
    const aware = layoutDocument(reading, off, measure);
    expect(aware).toEqual(plain);
    expect(textPlacements(aware).every((placement) => placement.bionic === undefined)).toBe(true);
  });

  it('marks only prose placements and keeps a preserved source region intact', () => {
    const blocks = [
      block('heading', 'A chapter title', { kind: 'heading' }),
      block('body', 'Ordinary body text.'),
      block('list', 'An ordinary list item.', { kind: 'list' }),
      block('footnote', 'An explanatory footnote.', { kind: 'footnote', semantic: 'note' }),
      block('reference', 'An ordinary reference.', { kind: 'reference' }),
      block('toc', 'A contents entry 12', { semantic: 'toc' }),
      block('index', 'An index entry 23', { semantic: 'index' }),
      block('caption', 'Figure 1. A caption.', { kind: 'caption' }),
      block('header', 'A repeated title', { running: 'header' }),
      block('table', '', {
        kind: 'sourceRegion',
        semantic: 'table',
        rect: { x: 40, y: 300, width: 100, height: 60 },
      }),
    ];
    const reading = document(blocks);
    const before = JSON.stringify(reading);
    const layout = layoutDocument(reading, config, measure);
    const placements = layout.pages.flatMap((page) => page.placements);
    for (const id of ['body', 'list', 'footnote', 'reference']) {
      const entries = placements.filter((placement) => placement.blockId === id);
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.every((placement) => placement.type === 'text' && placement.bionic)).toBe(
        true,
      );
    }
    for (const id of ['heading', 'toc', 'index', 'caption', 'header']) {
      const entries = placements.filter((placement) => placement.blockId === id);
      expect(entries.length).toBeGreaterThan(0);
      expect(
        entries.every((placement) => placement.type === 'text' && placement.bionic === undefined),
      ).toBe(true);
    }
    const table = placements.find((placement) => placement.blockId === 'table')!;
    expect(table.type).toBe('region');
    expect(table.type === 'region' && table.sourceRect).toEqual(blocks.at(-1)!.rect);
    expect('bionic' in table).toBe(false);
    expect(JSON.stringify(reading)).toBe(before);
  });

  it('keeps inline mathematical pixels and source text unchanged between emphasized prose', () => {
    const text = 'The model with R² preserves its exact mathematical expression and flowing prose.';
    const start = text.indexOf('R²');
    const body = block('body', text, {
      inlineMath: [
        {
          start,
          end: start + 2,
          sourceIds: ['body'],
          rect: { x: 80, y: 100, width: 8, height: 12 },
          baselineY: 108,
          fontSize: 8,
        },
      ],
    });
    const reading = document([body]);
    const before = JSON.stringify(reading);
    const on = layoutDocument(reading, config, measure);
    const off = layoutDocument(reading, { ...config, bionicReading: false }, measure);
    const placements = on.pages.flatMap((page) => page.placements);
    const math = placements.find((placement) => placement.type === 'region')!;
    const offMath = off.pages
      .flatMap((page) => page.placements)
      .find((placement) => placement.type === 'region')!;
    expect(math.type === 'region' && math.math).toBe(true);
    expect(math.type === 'region' && math.sourceRect).toEqual(body.inlineMath![0].rect);
    expect([math.width, math.height]).toEqual([offMath.width, offMath.height]);
    expect('bionic' in math).toBe(false);
    expect(textPlacements(on).every((placement) => placement.bionic === true)).toBe(true);
    expect(textPlacements(on).some((placement) => /\p{Co}/u.test(placement.text))).toBe(false);
    const restored = placements
      .map((placement) =>
        placement.type === 'text'
          ? normalized(placement.text)
          : normalized(body.text).slice(placement.textStart, placement.textEnd),
      )
      .join('');
    expect(restored).toBe(normalized(text));
    expect(JSON.stringify(reading)).toBe(before);
  });
});
