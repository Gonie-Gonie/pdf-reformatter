import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/core/config';
import { findLayoutAnchor, layoutDocument } from '../../src/core/layout';
import type { ReadingBlock, ReadingDocument, TextPlacement } from '../../src/core/model';

const measure = (text: string, size: number) => ([...text].length * size) / 2;
const config = {
  ...DEFAULT_CONFIG,
  pageWidthPt: 220,
  pageHeightPt: 300,
  marginLeftPt: 10,
  marginRightPt: 10,
  marginTopPt: 10,
  marginBottomPt: 10,
  fontSizePt: 10,
  lineHeightPercent: 150,
};
const text = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu';
function document(value = text, alignment?: ReadingBlock['alignment']): ReadingDocument {
  return {
    schemaVersion: 1,
    sourceHash: 'justified',
    warnings: [],
    blocks: [
      {
        id: 'body',
        kind: 'paragraph',
        sourcePage: 1,
        sourceIds: ['start', 'rest'],
        rect: { x: 20, y: 20, width: 200, height: 60 },
        rawText: value,
        text: value,
        fontSize: 10,
        confidence: 'high',
        ...(alignment ? { alignment } : {}),
        sourceSpans: [
          { sourceId: 'start', start: 0, end: 5, rect: { x: 20, y: 20, width: 25, height: 10 } },
          {
            sourceId: 'rest',
            start: 5,
            end: value.replace(/\s/gu, '').length,
            rect: { x: 50, y: 20, width: 100, height: 10 },
          },
        ],
      },
    ],
  };
}
function lines(layout: ReturnType<typeof layoutDocument>): TextPlacement[] {
  return layout.pages
    .flatMap((page) => page.placements)
    .filter((item): item is TextPlacement => item.type === 'text');
}

describe('paragraph justification', () => {
  it('justifies body paragraphs by default and leaves the final line ragged', () => {
    const placed = lines(layoutDocument(document(), config, measure));
    expect(placed).toHaveLength(2);
    expect(placed[0].width).toBeCloseTo(200);
    expect(placed[0].spacing?.length).toBeGreaterThan(0);
    expect(placed.at(-1)!.spacing).toBeUndefined();
    expect(placed.map((line) => line.text).join(' ')).toBe(text);
  });

  it('moves source-character anchors with the expanded word spaces', () => {
    const reading = document();
    const layout = layoutDocument(reading, config, measure);
    const first = lines(layout)[0];
    const anchor = findLayoutAnchor(
      layout,
      reading,
      { blockId: 'body', sourceId: 'rest' },
      measure,
    )!;
    expect(anchor.rect.x).toBeGreaterThan(first.x + measure('alpha ', 10));
    const firstGap = first.spacing!.find((gap) => gap.after === 'alpha '.length)!;
    expect(anchor.rect.x).toBeCloseTo(first.x + measure('alpha ', 10) + firstGap.extra);
  });

  it.each(['left', 'center', 'right'] as const)('honors inherited %s alignment', (alignment) => {
    const placed = lines(
      layoutDocument(document('A short paragraph.', alignment), config, measure),
    )[0];
    const remaining = 200 - measure(placed.text, placed.fontSize);
    const shift = alignment === 'right' ? remaining : alignment === 'center' ? remaining / 2 : 0;
    expect(placed.x).toBeCloseTo(10 + shift);
    expect(placed.spacing).toBeUndefined();
  });

  it('keeps the last line of each explicit paragraph ragged', () => {
    const placed = lines(layoutDocument(document(`${text}\n${text}`), config, measure));
    expect(placed).toHaveLength(4);
    expect(placed[0].spacing?.length).toBeGreaterThan(0);
    expect(placed[1].spacing).toBeUndefined();
    expect(placed[2].spacing?.length).toBeGreaterThan(0);
    expect(placed[3].spacing).toBeUndefined();
  });
});
