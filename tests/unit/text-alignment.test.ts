import { describe, expect, it } from 'vitest';
import {
  inferSourceAlignment,
  justifyLine,
  textAdvance,
  textSegments,
} from '../../src/core/text-alignment';
import type { SourceText, TextSpacing } from '../../src/core/model';

const measure = (text: string, size: number) => [...text].length * size * 0.5;

function row(id: string, x: number, width: number, y: number): SourceText {
  return {
    id,
    text: 'Ordinary source paragraph words.',
    x,
    y,
    width,
    height: 12,
    fontSize: 10,
    baselineY: y + 9,
    fontName: 'serif',
    hasEOL: true,
  };
}

describe('measured text justification', () => {
  it('distributes the exact remaining width across word gaps without changing text', () => {
    const text = 'alpha beta gamma';
    const spacing = justifyLine(text, measure(text, 10) + 8, 10, measure);
    expect(spacing).toEqual([
      { after: 6, extra: 4 },
      { after: 11, extra: 4 },
    ]);
    expect(
      textSegments(text, spacing)
        .map((segment) => segment.text)
        .join(''),
    ).toBe(text);
    expect(textAdvance({ text, fontSize: 10, spacing }, text.length, measure)).toBe(88);
  });

  it('does not spread Latin word letters, nonbreaking spaces, or a short sparse line', () => {
    expect(justifyLine('supercalifragilistic', 150, 10, measure)).toEqual([]);
    expect(justifyLine('alpha\u00a0beta', 70, 10, measure)).toEqual([]);
    expect(justifyLine('two words', 180, 10, measure)).toEqual([]);
  });

  it('adds advances between complete CJK graphemes when ordinary spaces are absent', () => {
    const text = '閱讀文字段落';
    const spacing = justifyLine(text, measure(text, 10) + 10, 10, measure);
    expect(spacing).toHaveLength(5);
    expect(spacing.every((gap) => gap.extra === 2)).toBe(true);
    expect(
      textSegments(text, spacing)
        .map((segment) => segment.text)
        .join(''),
    ).toBe(text);
  });

  it('keeps combining sequences and emoji whole when applying spacing', () => {
    const text = 'A\u0301 👨‍👩‍👧‍👦 beta';
    const spacing: TextSpacing[] = [
      { after: 1, extra: 100 },
      { after: 3, extra: 2 },
      { after: 5, extra: 100 },
    ];
    const segments = textSegments(text, spacing);
    expect(segments).toEqual([
      { text: 'A\u0301 ', extraAfter: 2 },
      { text: '👨‍👩‍👧‍👦 beta', extraAfter: 0 },
    ]);
  });

  it('moves an anchor after a stretched space by the same distance as rendered text', () => {
    const placement = {
      text: 'alpha beta gamma',
      fontSize: 10,
      spacing: [
        { after: 6, extra: 4 },
        { after: 11, extra: 4 },
      ],
    };
    expect(textAdvance(placement, 5, measure)).toBe(measure('alpha', 10));
    expect(textAdvance(placement, 6, measure)).toBe(measure('alpha ', 10) + 4);
    expect(textAdvance(placement, 11, measure)).toBe(measure('alpha beta ', 10) + 8);
  });
});

describe('source paragraph alignment', () => {
  it('uses consistent explicit alignment even for one source line', () => {
    expect(inferSourceAlignment([{ ...row('one', 30, 200, 50), alignment: 'left' }])).toBe('left');
    expect(
      inferSourceAlignment([
        { ...row('one', 30, 200, 50), alignment: 'left' },
        { ...row('two', 30, 180, 70), alignment: 'right' },
      ]),
    ).toBeUndefined();
  });

  it('recognizes three distinct centered or right aligned source rows', () => {
    expect(
      inferSourceAlignment([
        row('one', 100, 200, 50),
        row('two', 70, 260, 70),
        row('three', 130, 140, 90),
      ]),
    ).toBe('center');
    expect(
      inferSourceAlignment([
        row('one', 100, 200, 50),
        row('two', 70, 230, 70),
        row('three', 130, 170, 90),
      ]),
    ).toBe('right');
  });

  it('recognizes a persistently ragged right edge while ignoring indentation and the final line', () => {
    expect(
      inferSourceAlignment([
        row('first', 45, 180, 50),
        row('one', 30, 220, 70),
        row('two', 30, 180, 90),
        row('three', 30, 240, 110),
        row('last', 30, 80, 130),
      ]),
    ).toBe('left');
  });

  it('does not mistake a justified paragraph or two isolated rows for centered text', () => {
    expect(
      inferSourceAlignment([
        row('first', 45, 235, 50),
        row('one', 30, 250, 70),
        row('two', 30, 250, 90),
        row('three', 30, 250, 110),
        row('last', 30, 80, 130),
      ]),
    ).toBeUndefined();
    expect(
      inferSourceAlignment([row('one', 100, 200, 50), row('two', 70, 260, 70)]),
    ).toBeUndefined();
  });
});
