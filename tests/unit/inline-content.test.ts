import { describe, expect, it } from 'vitest';
import {
  flowingText,
  inlineContent,
  inlineFragments,
  normalizedLength,
} from '../../src/core/inline-content';
import { paragraphContent } from '../../src/core/paragraph-content';
import type { InlineMathSpan, SourceText } from '../../src/core/model';

function item(id: string, text: string, x: number, width: number): SourceText {
  return {
    id,
    text,
    x,
    y: 90,
    width,
    height: 14,
    fontSize: 10,
    baselineY: 100,
    fontName: 'body',
    hasEOL: false,
  };
}

function math(start: number, end: number, overrides: Partial<InlineMathSpan> = {}): InlineMathSpan {
  return {
    start,
    end,
    sourceIds: ['math-source'],
    rect: { x: 150, y: 90, width: 20, height: 12 },
    baselineY: 100,
    fontSize: 10,
    ...overrides,
  };
}

describe('paragraph source offsets', () => {
  it('maps partial math in trimmed source runs using raw UTF-16 offsets', () => {
    const left = item('left', '  \u{1f4d6} Coefficient (R', 50, 100);
    const power = item('power', '2', 150, 4);
    const right = item('right', '). Ordinary prose remains.  ', 154, 130);
    const content = paragraphContent([{ items: [left, power, right] }]);

    expect(content.text).toBe('\u{1f4d6} Coefficient (R2). Ordinary prose remains.');
    const leftRange = content.ranges.get('left')!;
    const powerRange = content.ranges.get('power')!;
    const rightRange = content.ranges.get('right')!;
    expect(leftRange).toMatchObject({ start: 0, end: 17, localStart: 2 });
    expect(powerRange).toMatchObject({ start: 17, end: 18, localStart: 0 });
    expect(rightRange.end).toBe(content.text.length);
    const rawStart = leftRange.start + left.text.indexOf('(R') - leftRange.localStart;
    const rawEnd = rightRange.start + 1;
    expect(content.text.slice(rawStart, rawEnd)).toBe('(R2)');
    expect(content.sourceSpans.find((span) => span.sourceId === 'power')).toMatchObject({
      start: 15,
      end: 16,
      rect: { x: 150, y: 90, width: 4, height: 14 },
    });

    const block = { text: content.text, inlineMath: [math(rawStart, rawEnd)] };
    expect(flowingText(block)).toBe('\u{1f4d6} Coefficient . Ordinary prose remains.');
    expect([...inlineContent(block).atoms.values()][0].text).toBe('(R2)');
  });

  it('keeps composed combining marks anchored when NFKC changes source lengths', () => {
    const base = item('base', '  \ufb01 e', 20, 30);
    const accent = item('accent', '\u0301', 50, 0.5);
    const tail = item('tail', ' = \u03b1', 50.5, 15);
    const content = paragraphContent([{ items: [base, accent, tail] }]);

    expect(content.text).toBe('\ufb01 e\u0301 = \u03b1');
    expect(content.ranges.get('accent')).toMatchObject({ start: 3, end: 4, localStart: 0 });
    expect(
      content.sourceSpans.map(({ sourceId, start, end }) => ({ sourceId, start, end })),
    ).toEqual([
      { sourceId: 'base', start: 0, end: 3 },
      { sourceId: 'accent', start: 2, end: 3 },
      { sourceId: 'tail', start: 3, end: 5 },
    ]);
    expect(normalizedLength(content.text)).toBe(5);
  });

  it('retains raw item ranges while joining hyphenated rows and adding ordinary row spaces', () => {
    const first = item('first', '  cross-', 20, 40);
    const second = item('second', 'column text  ', 20, 90);
    const third = item('third', 'continues.', 20, 50);
    const content = paragraphContent([{ items: [first] }, { items: [second] }, { items: [third] }]);

    expect(content.text).toBe('cross-column text continues.');
    expect(content.ranges.get('second')).toMatchObject({ start: 6, end: 17, localStart: 0 });
    expect(content.ranges.get('third')).toMatchObject({ start: 18, end: 28, localStart: 0 });
  });
});

describe('inline math content', () => {
  it('round-trips original formula text through private markers while preserving all surrounding prose', () => {
    const text = 'The \u03b1\u2081 + \u03b2 value and R\u00b2 explain the result.';
    const firstStart = text.indexOf('\u03b1');
    const firstEnd = text.indexOf(' value');
    const secondStart = text.indexOf('R\u00b2');
    const spans = [math(secondStart, secondStart + 2), math(firstStart, firstEnd)];
    const content = inlineContent({ text, inlineMath: spans });
    const fragments = inlineFragments(content.text, content.atoms);

    expect(content.atoms.size).toBe(2);
    expect(fragments.map((fragment) => fragment.text).join('')).toBe(text);
    expect(fragments.filter((fragment) => fragment.atom).map((fragment) => fragment.text)).toEqual([
      '\u03b1\u2081 + \u03b2',
      'R\u00b2',
    ]);
    expect(flowingText({ text, inlineMath: spans })).toBe('The  value and  explain the result.');
    expect(text).toBe('The \u03b1\u2081 + \u03b2 value and R\u00b2 explain the result.');
  });

  it('uses raw UTF-16 formula ranges but normalized source anchors', () => {
    const text = '\u{1f4d6} \ufb01 e\u0301 \u03b1\u2081 stays raw.';
    const start = text.indexOf('\u03b1');
    const content = inlineContent({ text, inlineMath: [math(start, start + 2)] });
    const atom = [...content.atoms.values()][0];

    expect(start).toBe(8);
    expect(atom.text).toBe('\u03b1\u2081');
    expect(atom.sourceStart).toBe(5);
    expect(atom.sourceEnd).toBe(7);
    expect(
      inlineFragments(content.text, content.atoms)
        .map((fragment) => fragment.text)
        .join(''),
    ).toBe(text);
  });

  it('does not consume pre-existing private characters when assigning internal markers', () => {
    const privateCharacter = String.fromCodePoint(0xf0000);
    const text = `${privateCharacter} ordinary \u03b1 remains.`;
    const start = text.indexOf('\u03b1');
    const content = inlineContent({ text, inlineMath: [math(start, start + 1)] });

    expect(content.atoms.has(privateCharacter)).toBe(false);
    expect(content.text.startsWith(privateCharacter)).toBe(true);
    expect(flowingText({ text, inlineMath: [math(start, start + 1)] })).toBe(
      `${privateCharacter} ordinary  remains.`,
    );
  });

  it('ignores invalid or overlapping ranges and excludes only valid preserved math from flowing text', () => {
    const text = 'Before \u03b1 after \u03b2 end.';
    const alpha = text.indexOf('\u03b1');
    const beta = text.indexOf('\u03b2');
    const inlineMath = [
      math(-1, 2),
      math(0.5, 2),
      math(2, 2),
      math(alpha, alpha + 1),
      math(alpha, beta + 1),
      math(beta, text.length + 1),
      math(beta, beta + 1, { rect: { x: 0, y: 0, width: 0, height: 1 } }),
      math(beta, beta + 1, { baselineY: Number.NaN }),
      math(beta, beta + 1, { fontSize: 0 }),
    ];
    const content = inlineContent({ text, inlineMath });

    expect(content.atoms.size).toBe(1);
    expect([...content.atoms.values()][0].text).toBe('\u03b1');
    expect(flowingText({ text, inlineMath })).toBe('Before  after \u03b2 end.');
    expect(flowingText({ text })).toBe(text);
  });
});
