import { describe, expect, it } from 'vitest';
import { analyzeDocument } from '../../src/core/analyze';
import type { SourceDocument, SourcePage, SourceText } from '../../src/core/model';

function text(
  id: string,
  value: string,
  x: number,
  y: number,
  width: number,
  size = 10,
): SourceText {
  return {
    id,
    text: value,
    x,
    y,
    width,
    height: size,
    fontSize: size,
    baselineY: y + size * 0.8,
    fontName: 'serif',
    hasEOL: false,
  };
}
function source(items: SourceText[], graphics: SourcePage['graphicRegions'] = []): SourceDocument {
  return {
    schemaVersion: 1,
    hash: 'split-display',
    name: 'equations.pdf',
    engine: 'synthetic',
    pageCount: 1,
    pages: [
      {
        number: 1,
        width: 600,
        height: 800,
        rotation: 0,
        items,
        graphicRegions: graphics,
        warnings: [],
      },
    ],
  };
}

describe('compound display equation ownership', () => {
  it('keeps a rotated sidebar from joining unrelated prose and fraction baselines', () => {
    const sidebar: SourceText = {
      ...text('sidebar', 'ACOUSTICS', 20, 240, 12, 12),
      height: 49,
      baselineY: undefined,
      rotation: -90,
      preserve: true,
    };
    const reading = analyzeDocument(
      source([
        sidebar,
        text('before', 'The first step is to calculate the room factor.', 83, 241, 198, 9),
        text('continuation', 'The three situations have different absorption.', 95, 252, 180, 9),
        text('lhs', 'R', 114, 271, 5, 9),
        text('equals', '=', 121, 270, 5, 9),
        text('numerator', 'Sα', 133, 265, 12, 9),
        text('denominator', '1 − α', 128, 278, 20, 9),
        text('after', 'The following text remains ordinary editable prose.', 83, 315, 198, 9),
      ]),
    );
    const formula = reading.blocks.find((block) => block.sourceIds.includes('equals'))!;
    expect(formula.kind).toBe('sourceRegion');
    expect(formula.sourceIds).toEqual(expect.arrayContaining(['lhs', 'numerator', 'denominator']));
    for (const id of ['before', 'continuation', 'after'])
      expect(formula.sourceIds).not.toContain(id);
  });

  it('keeps short explanatory prose between adjacent display equations editable', () => {
    const reading = analyzeDocument(
      source([
        text('before', 'The following two expressions are evaluated separately.', 54, 170, 320),
        text('first', 'x = 1', 170, 200, 40),
        text('explanation', 'The residual is negative definite.', 54, 213, 260),
        text('second', 'y = 2', 170, 228, 40),
        text('after', 'The final paragraph continues the original explanation.', 54, 270, 320),
      ]),
    );
    const first = reading.blocks.find((block) => block.sourceIds.includes('first'))!;
    const second = reading.blocks.find((block) => block.sourceIds.includes('second'))!;
    expect(first.kind).toBe('sourceRegion');
    expect(second.kind).toBe('sourceRegion');
    expect(first.id).not.toBe(second.id);
    expect(reading.blocks.find((block) => block.sourceIds.includes('explanation'))?.kind).toBe(
      'paragraph',
    );
  });

  it('preserves locally proven quote/hash-encoded square brackets with their equation', () => {
    const document = source(
      [
        text('before', 'The governing equation is expanded using the chain rule.', 68, 400, 380),
        text('left', '"', 205, 431, 6),
        text('right', '#', 245, 431, 6),
        text('lhs', 'du/dt =', 162, 450, 38),
        text('numerator', '∂f + ∂g', 214, 440, 28),
        text('denominator', '∂x  ∂y', 214, 455, 28),
        text('number', '(6.26)', 425, 450, 25),
        text('after', 'The following normal explanatory paragraph remains editable.', 68, 490, 380),
      ],
      [
        { x: 206, y: 442, width: 8, height: 31 },
        { x: 245, y: 442, width: 6, height: 31 },
      ],
    );
    const reading = analyzeDocument(document);
    const formula = reading.blocks.find((block) => block.sourceIds.includes('numerator'))!;
    expect(formula.sourceIds).toEqual(
      expect.arrayContaining(['left', 'right', 'lhs', 'denominator', 'number']),
    );
    for (const id of ['before', 'after'])
      expect(reading.blocks.find((block) => block.sourceIds.includes(id))?.kind).toBe('paragraph');
  });

  it('leaves quote and hash characters alone without matching mathematical ink', () => {
    const reading = analyzeDocument(
      source([
        text(
          'prose',
          'The quoted title uses a hash character in an ordinary sentence.',
          54,
          100,
          380,
        ),
        text('left', '"', 205, 150, 6),
        text('right', '#', 245, 150, 6),
      ]),
    );
    expect(reading.blocks.every((block) => block.kind === 'paragraph')).toBe(true);
  });

  it('keeps legacy fraction glyphs, denominator and a chapter-qualified number together', () => {
    const items = [
      text('before', 'The normalized derivative is evaluated as follows.', 54, 170, 320),
      text('numerator', '\u0005Zi Y', 213, 200, 25),
      text('lhs', 'S', 187, 208, 6),
      text('relation', '=', 202, 208, 8),
      text('denominator', '\u0005Y Zi', 213, 215, 25),
      text('number', '(1.12)', 350, 208, 26),
      text('after', 'The following explanatory paragraph remains normal prose.', 54, 250, 320),
    ];
    const reading = analyzeDocument(source(items));
    const formula = reading.blocks.find((block) => block.sourceIds.includes('numerator'))!;
    expect(formula.kind).toBe('sourceRegion');
    expect(formula.sourceIds).toEqual(
      expect.arrayContaining(['lhs', 'relation', 'denominator', 'number']),
    );
    for (const id of ['before', 'after'])
      expect(reading.blocks.find((block) => block.sourceIds.includes(id))?.kind).toBe('paragraph');
  });

  it.each(['(2.3)', '(A.4)', 'ð1:4Þ'])(
    'attaches the %s display number to its equation',
    (label) => {
      const items = [
        text('before', 'The ordinary explanatory paragraph is above the equation.', 54, 170, 320),
        text('formula', 'E = mc²', 170, 210, 60),
        text('number', label, 350, 210, 30),
        text('after', 'The following ordinary paragraph must remain editable.', 54, 250, 320),
      ];
      const reading = analyzeDocument(source(items));
      const formula = reading.blocks.find((block) => block.sourceIds.includes('formula'))!;
      expect(formula.sourceIds).toContain('number');
      expect(formula.sourceIds).not.toContain('before');
      expect(formula.sourceIds).not.toContain('after');
    },
  );

  it('recovers a plain single-letter denominator beside a detected mathematical row', () => {
    const reading = analyzeDocument(
      source([
        text('before', 'The following local ratio is used in the calculation.', 54, 170, 320),
        text('numerator', 'Q', 205, 200, 6),
        text('lhs', 'R =', 180, 208, 20),
        text('denominator', 'k', 205, 216, 5),
        text('after', 'An unrelated body paragraph follows the ratio.', 54, 250, 320),
      ]),
    );
    const formula = reading.blocks.find((block) => block.sourceIds.includes('lhs'))!;
    expect(formula.sourceIds).toEqual(expect.arrayContaining(['numerator', 'denominator']));
    expect(reading.blocks.find((block) => block.sourceIds.includes('after'))?.kind).toBe(
      'paragraph',
    );
  });

  it('joins a prose figure reference into its paragraph while retaining a real nearby caption', () => {
    const document = source(
      [
        text('first', 'The remaining activities are shown in', 54, 100, 320),
        text(
          'reference',
          'Figure 2.14. On a large project, the team coordinates its efforts.',
          54,
          112,
          320,
        ),
        text(
          'continuation',
          'The following explanation continues the same paragraph.',
          54,
          124,
          320,
        ),
        text('caption', 'Figure 1.2 shows the relationship between the two models.', 54, 320, 320),
      ],
      [{ x: 54, y: 180, width: 320, height: 130 }],
    );
    const reading = analyzeDocument(document);
    const prose = reading.blocks.find((block) => block.sourceIds.includes('reference'))!;
    expect(prose.kind).toBe('paragraph');
    expect(prose.sourceIds).toEqual(['first', 'reference', 'continuation']);
    expect(reading.blocks.find((block) => block.sourceIds.includes('caption'))?.kind).toBe(
      'caption',
    );
  });

  it('attaches an unclaimed single-letter left side to a tagged display frame', () => {
    const items = [
      text('before', 'The time-dependent concentration is calculated below.', 58, 270, 235),
      text('lhs', 'n', 82.9, 302.49, 5.34),
      text('rhs', '(t) = n0 · exp', 90.24, 302.49, 57),
      text('negative', '−', 151.836, 301.211, 7.8),
      text('numerator', 'Q', 169.246, 295.481, 6.68),
      text('denominator', 'V', 169.521, 309.592, 5.39),
      text('tail', '+ D + k', 179.341, 302.49, 45),
      text('after', 'The following explanatory paragraph stays editable.', 58, 340, 235),
    ];
    const document = source(items);
    document.pages[0].structure = [
      {
        id: 'eq',
        role: 'Formula',
        order: 0,
        sourceIds: ['rhs', 'negative', 'numerator', 'denominator', 'tail'],
      },
    ];
    const reading = analyzeDocument(document);
    const formula = reading.blocks.find((block) => block.sourceIds.includes('numerator'))!;
    expect(formula.kind).toBe('sourceRegion');
    expect(formula.sourceIds).toContain('lhs');
    for (const id of ['before', 'after'])
      expect(reading.blocks.find((block) => block.sourceIds.includes(id))!.kind).toBe('paragraph');
  });

  it('attaches a raised single-letter upper limit to a tall display sum', () => {
    const items = [
      text(
        'before',
        'The elementary effects are averaged using the following expression.',
        180,
        85,
        380,
      ),
      { ...text('upper', 'r', 354.836, 109.859, 2.991, 7.5716), baselineY: 115.28 },
      {
        ...text('sum', '∑', 350.981, 116.256, 10.698, 13.9477),
        height: 14.6451,
        baselineY: 128.112,
      },
      text('lhs', 'µ =', 330.168, 119.156, 17),
      { ...text('lower', 'i=1', 350.175, 131.353, 12.3, 7.5716), baselineY: 136.774 },
      text('term', '|EEi|/r', 364.271, 118.388, 31.23),
      text('after', 'The remaining ordinary paragraph must keep flowing as prose.', 180, 155, 380),
    ];
    const document = source(items);
    document.pages[0].structure = [
      { id: 'eq', role: 'Formula', order: 0, sourceIds: ['sum', 'lhs', 'lower', 'term'] },
    ];
    const reading = analyzeDocument(document);
    const formula = reading.blocks.find((block) => block.sourceIds.includes('sum'))!;
    expect(formula.kind).toBe('sourceRegion');
    expect(formula.sourceIds).toContain('upper');
    for (const id of ['before', 'after'])
      expect(reading.blocks.find((block) => block.sourceIds.includes(id))!.kind).toBe('paragraph');
  });

  it('keeps raised legacy delimiter glyphs in their equation instead of accented prose', () => {
    const items = [
      text('before', 'The emissions are calculated using this expression.', 309, 380, 241),
      { ...text('left', 'À', 398.041, 398.782, 4.47), height: 10.5001, baselineY: 407.282 },
      { ...text('right', 'Á', 456.831, 398.782, 4.47), height: 10.5001, baselineY: 407.282 },
      text('lhs', 'CEa', 370.094, 408.264, 15.302),
      text('relation', '¼', 388.12, 406.889, 7.7),
      text('first', 'Eimp', 402.52, 408.269, 16.756),
      text('minus', '−', 427.011, 406.889, 6.66),
      text('second', 'Eexp', 435.911, 408.269, 15.441),
      text('times', '×', 463.521, 406.892, 6.35),
      text('factor', 'CEFeg', 472.142, 408.272, 23.52),
      text('number', '(6)', 537.5, 408.439, 12.5),
      text('after', 'The ordinary paragraph following the equation stays text.', 309, 440, 241),
    ];
    const reading = analyzeDocument(source(items));
    const formula = reading.blocks.find((block) => block.sourceIds.includes('lhs'))!;
    expect(formula.kind).toBe('sourceRegion');
    expect(formula.sourceIds).toEqual(
      expect.arrayContaining(['left', 'right', 'relation', 'first', 'second', 'factor', 'number']),
    );
    expect(formula.rect.y).toBeGreaterThan(403);
    expect(
      reading.blocks.filter((block) => block.kind === 'paragraph').map((block) => block.text),
    ).toEqual(expect.arrayContaining([items[0].text, items.at(-1)!.text]));
  });

  it('keeps ordinary accented Latin letters without an enclosing mathematical row as text', () => {
    const items = [text('left', 'À', 100, 100, 5), text('right', 'Á', 160, 100, 5)];
    expect(analyzeDocument(source(items)).blocks.every((block) => block.kind === 'paragraph')).toBe(
      true,
    );
  });

  it('keeps a legacy-encoded integral fraction with its label and limits', () => {
    const items = [
      {
        ...text('before', 'energy usage is expressed as', 50, 648.948, 113.405),
        baselineY: 656.068,
      },
      text('label', 'renergy usage', 108, 683, 39),
      text('equals', '¼', 150, 682, 8),
      text('one', '1', 160, 683, 5),
      text('minus', '−', 167, 682, 7),
      {
        ...text('integral-top', 'Z', 175.861, 654.581, 5.52),
        height: 10.5001,
        baselineY: 663.081,
        fontName: 'sans-serif legacy-integrals',
      },
      text('upper-top', 't2', 186, 663, 5, 7),
      text('lower-top', 't1', 182, 680, 5, 7),
      text('numerator', 'Edumped t', 192, 670, 36),
      text('parens-top', 'ð Þ', 221, 668, 11),
      text('dt-top', 'dt', 232, 670, 8),
      text('integral-bottom', 'Z', 176, 681, 6),
      text('upper-bottom', 't2', 186, 689, 5, 7),
      text('lower-bottom', 't1', 182, 707, 5, 7),
      text('denominator', 'ERE', 192, 696, 14),
      text('total', 'total', 208, 700, 17, 7),
      text('parens-bottom', 'ð Þ', 221, 694, 11),
      text('dt-bottom', 'dt', 232, 696, 8),
      text('number-open', 'ð', 278.468, 682.022, 3.85),
      text('number', '4', 282.318, 683.402, 4.79),
      text('number-close', 'Þ', 287.138, 682.022, 3.85),
      text('after', 'The following ordinary paragraph remains editable.', 50, 730, 450),
    ];
    const reading = analyzeDocument(source(items, [{ x: 177, y: 666, width: 65, height: 40 }]));
    const formula = reading.blocks.find((block) => block.sourceIds.includes('label'))!;
    expect(formula.kind).toBe('sourceRegion');
    expect(formula.sourceIds).toEqual(
      expect.arrayContaining([
        'integral-top',
        'upper-top',
        'lower-top',
        'integral-bottom',
        'lower-bottom',
        'total',
        'number-open',
        'number',
        'number-close',
      ]),
    );
    expect(formula.rect.y).toBeGreaterThanOrEqual(659.198);
    expect(formula.sourceIds).not.toContain('before');
    expect(reading.blocks.find((block) => block.sourceIds.includes('before'))!.kind).toBe(
      'paragraph',
    );
    expect(reading.blocks.find((block) => block.sourceIds.includes('after'))!.kind).toBe(
      'paragraph',
    );
  });

  it('keeps a complete equality row with absolute-value delimiters attached to its fraction', () => {
    const items = [
      text('before', 'The following displayed expression defines the quantity:', 50, 100, 450),
      text('label', 'MAE', 313, 237, 19, 9),
      text('equals', '=', 335, 237, 7, 9),
      text('numerator', '1', 346, 231, 4, 9),
      text('denominator', 'n', 346, 244, 5, 9),
      { ...text('sum', '∑', 353, 229, 13, 9), height: 22 },
      text('index', 'i=1', 355, 250, 10, 7),
      { ...text('bar', '∣', 368, 235, 3, 9), height: 22 },
      text('variable', 'yi', 371, 237, 6, 9),
      text('difference', '− ˆ', 379, 237, 13, 9),
      text('predicted', 'yi', 388, 237, 6, 9),
      { ...text('ending', '∣', 395, 235, 3, 9), height: 22 },
      text('after', 'The following ordinary paragraph remains editable.', 50, 280, 450),
    ];
    const reading = analyzeDocument(source(items, [{ x: 344, y: 243, width: 9, height: 0.7 }]));
    const formula = reading.blocks.find((block) => block.sourceIds.includes('sum'))!;
    expect(formula.kind).toBe('sourceRegion');
    expect(formula.sourceIds).toEqual(
      expect.arrayContaining(['label', 'equals', 'variable', 'difference', 'predicted']),
    );
    expect(reading.blocks.find((block) => block.sourceIds.includes('after'))!.kind).toBe(
      'paragraph',
    );
  });

  it.each(['MAE', 'MAPE', 'LOSS'])(
    'keeps an untagged %s label and equality before its fraction',
    (label) => {
      const items = [
        text('before', 'The following displayed expression defines the quantity:', 50, 100, 450),
        text('label', label, 210, 140, 28),
        text('equals', '=', 242, 140, 7),
        text('numerator', '1', 256, 134, 5),
        text('denominator', 'n', 256, 148, 5),
        { ...text('sum', '∑', 270, 132, 13), height: 30 },
        text('index', 'i=1', 270, 153, 12, 7),
        text('term', '|x−y|', 289, 140, 30),
        text('after', 'The following ordinary paragraph remains editable.', 50, 180, 450),
      ];
      const reading = analyzeDocument(source(items, [{ x: 254, y: 145, width: 10, height: 0.7 }]));
      const formula = reading.blocks.find((block) => block.sourceIds.includes('sum'))!;
      expect(formula.kind).toBe('sourceRegion');
      expect(formula.sourceIds).toEqual(
        expect.arrayContaining(['label', 'equals', 'numerator', 'denominator', 'sum', 'term']),
      );
      expect(reading.blocks.find((block) => block.sourceIds.includes('before'))!.kind).toBe(
        'paragraph',
      );
      expect(reading.blocks.find((block) => block.sourceIds.includes('after'))!.kind).toBe(
        'paragraph',
      );
      expect(reading.blocks.flatMap((block) => block.sourceIds).sort()).toEqual(
        items.map((item) => item.id).sort(),
      );
    },
  );
});
