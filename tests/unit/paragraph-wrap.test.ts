import { describe, expect, it } from 'vitest';
import { hyphenationPoints, wrapParagraph } from '../../src/core/paragraph-wrap';
import { justifyLine } from '../../src/core/text-alignment';

const measure = (text: string, size: number) => [...text].length * size * 0.5;
const visible = (text: string) => text.replace(/\u00ad/gu, '-');
const logical = (text: string) => text.replace(/[\s\u00ad]/gu, '');

describe('paragraph word breaking', () => {
  it('uses dictionary break positions for ordinary English words', () => {
    expect(hyphenationPoints('forecasting')).toContain(4);
    expect(hyphenationPoints('Forecasting')).toEqual(hyphenationPoints('forecasting'));
    for (const word of ['RMSE', 'XGBoost', 'https://example.com', 'alpha_1', '123456', 'model'])
      expect(hyphenationPoints(word)).toEqual([]);
  });

  it('keeps complete source characters while fitting dictionary-hyphenated lines', () => {
    const source = 'Forecast evaluation uses counterfactual operational scheduling and regression.';
    const lines = wrapParagraph(source, 125, 10, measure);
    expect(lines.some((line) => line.endsWith('\u00ad'))).toBe(true);
    expect(logical(lines.join(''))).toBe(logical(source));
    expect(lines.every((line) => measure(visible(line), 10) <= 125)).toBe(true);
    expect(lines.some((line) => /[a-z]-$/u.test(line))).toBe(false);
  });

  it('keeps acronyms and URLs free of invented hyphens', () => {
    const source =
      'Use RMSE and CV-RMSE with https://example.com/very-long-resource?alpha=123456789.';
    const lines = wrapParagraph(source, 100, 10, measure);
    expect(logical(lines.join(''))).toBe(logical(source));
    const url = lines.slice(lines.findIndex((line) => line.includes('https:'))).join('');
    expect(url).not.toContain('\u00ad');
    expect(url).toContain('https://example.com/very-long-resource?alpha=123456789.');
  });

  it('keeps supplementary formula markers intact with custom object advances', () => {
    const atom = '\u{f0000}';
    const source = `Forecasts use ${atom} and ${atom} for operational evaluation.`;
    const custom = (text: string, size: number) =>
      [...text].reduce((sum, character) => sum + (character === atom ? 45 : size * 0.5), 0);
    const lines = wrapParagraph(source, 100, 10, custom);
    expect(logical(lines.join(''))).toBe(logical(source));
    expect(lines.every((line) => custom(visible(line), 10) <= 100)).toBe(true);
    expect(lines.join('').match(/\u{f0000}/gu)).toHaveLength(2);
  });

  it('verifies final rows when a measure has non-additive contextual advances', () => {
    const source =
      'Forecast evaluation uses operational scheduling across several building systems.';
    const contextual = (text: string, size: number) =>
      measure(text, size) + Math.max(0, (text.match(/ /gu) ?? []).length - 1) * 20;
    const lines = wrapParagraph(source, 125, 10, contextual);
    expect(logical(lines.join(''))).toBe(logical(source));
    expect(lines.every((line) => contextual(visible(line), 10) <= 125)).toBe(true);
  });

  it('preserves source hard hyphens and removes unused discretionary markers', () => {
    const source = 'A one-zone-per-floor representation uses opera\u00adtional data.';
    const lines = wrapParagraph(source, 140, 10, measure);
    expect(logical(lines.join(''))).toBe(logical(source));
    expect(lines.join('')).toContain('one-zone-per-floor');
    expect(wrapParagraph('opera\u00adtional data.', 300, 10, measure)).toEqual([
      'operational data.',
    ]);
  });

  it('keeps explicit paragraph boundaries and complete CJK graphemes', () => {
    const source = '한글과漢字를함께읽습니다。\n\nA\u0301 combining sequence remains intact.';
    const lines = wrapParagraph(source, 70, 10, measure);
    expect(logical(lines.join(''))).toBe(logical(source));
    expect(lines).toContain('');
    expect(lines.every((line) => !/^\p{Mark}/u.test(line))).toBe(true);
    expect(lines.every((line) => !/^[。]/u.test(line))).toBe(true);
  });

  it('avoids the large unused gaps of a greedy unhyphenated narrow paragraph', () => {
    const source =
      'Data-driven short-term load forecasting is a mature and active research area. New models are proposed continuously and are almost always justified by a reduction in a statistical error metric, typically RMSE, MAE, mean absolute percentage error or CV-RMSE, relative to a set of baselines.';
    const lines = wrapParagraph(source, 160, 10, measure);
    const body = lines.slice(0, -1);
    const sparse = body.filter((line) => {
      const gaps = (line.match(/ /gu) ?? []).length;
      return gaps && (160 - measure(visible(line), 10)) / gaps > 10;
    });
    expect(sparse.length).toBeLessThanOrEqual(1);
    expect(logical(lines.join(''))).toBe(logical(source));
    for (const line of body.filter((line) => (line.match(/ /gu) ?? []).length >= 2)) {
      const spacing = justifyLine(line, 160, 10, (value, size) => measure(visible(value), size));
      if (spacing.length)
        expect(
          measure(visible(line), 10) + spacing.reduce((sum, gap) => sum + gap.extra, 0),
        ).toBeCloseTo(160);
    }
  });

  it('rejects unplaceable glyphs and invalid measurements', () => {
    expect(() => wrapParagraph('wider', 3, 10, measure)).toThrow(RangeError);
    expect(() => wrapParagraph('words', 100, 10, () => NaN)).toThrow(RangeError);
    expect(() => wrapParagraph('words', 0, 10, measure)).toThrow(RangeError);
  });
});

describe('paragraph justification', () => {
  it('fills normal narrow body rows while retaining a sparse-line spacing limit', () => {
    const text = 'Forecast evaluation uses building data';
    const gaps = 4;
    const width = measure(text, 10) + gaps * 11;
    const spacing = justifyLine(text, width, 10, measure);
    expect(spacing).toHaveLength(gaps);
    expect(measure(text, 10) + spacing.reduce((sum, gap) => sum + gap.extra, 0)).toBeCloseTo(width);
    expect(justifyLine(text, measure(text, 10) + gaps * 14, 10, measure)).toEqual([]);
    expect(justifyLine('citation entry', measure('citation entry', 10) + 7, 10, measure)).toEqual(
      [],
    );
  });
});
