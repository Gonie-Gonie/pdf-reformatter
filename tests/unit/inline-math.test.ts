import { describe, expect, it } from 'vitest';
import { inlineMathAtoms } from '../../src/core/inline-math';
import type { SourcePage, SourceText } from '../../src/core/model';
import { union } from '../../src/core/geometry';

function item(
  id: string,
  text: string,
  x: number,
  width: number,
  size = 10,
  baseline = 100,
): SourceText {
  return {
    id,
    text,
    x,
    y: baseline - size * 1.2,
    width,
    height: size * 1.6,
    fontSize: size,
    baselineY: baseline,
    fontName: 'body',
    hasEOL: false,
  };
}
function source(items: SourceText[]): SourcePage {
  return {
    number: 1,
    width: 600,
    height: 800,
    rotation: 0,
    items,
    graphicRegions: [],
    warnings: [],
  };
}
function row(items: SourceText[]) {
  return {
    items,
    rect: union(items),
    text: items.map((entry) => entry.text).join(' '),
    fontSize: 10,
  };
}

describe('inline mathematical objects', () => {
  it('keeps an unmapped symbol with its equals-led definition rather than the next variable', () => {
    const phi = {
      ...item('phi', '\u0002', 80.221, 7.78, 10, 386.857),
      y: 378.357,
      height: 10.5,
      fontName: 'legacy-symbol',
    };
    const sub = item('sub', 'j', 88.001, 1.332, 6, 390.157);
    const description = item('description', '= Flux CTF coefficient,', 92.221, 95.125, 10, 386.857);
    const nextVariable = { ...item('next', 'T', 80.221, 5.75, 10, 400.607), fontName: 'italic' };
    const nextSub = item('next-sub', 'i', 85.971, 1.332, 6, 403.907);
    const nextDescription = item(
      'next-description',
      '= Inside surface temperature (°C),',
      92.221,
      138.12,
      10,
      400.607,
    );
    const page = source([phi, sub, description, nextVariable, nextSub, nextDescription]);
    const atoms = inlineMathAtoms(page, [
      row([phi, sub, description]),
      row([nextVariable, nextSub, nextDescription]),
    ]);
    const atom = atoms.find((entry) => entry.sourceIds.includes('phi'))!;
    expect(atom.sourceIds).toEqual(['phi', 'sub']);
    expect(atom.baselineY).toBeCloseTo(386.857);
    expect(atom.rect.y).toBeLessThanOrEqual(phi.y);
    expect(atom.sourceIds).not.toContain('next');
  });

  it('keeps raised delimiters on a short definition row instead of inventing a wrapped row', () => {
    const previous = item('previous', 'A small conditional quantity will', 30, 250, 10, 100);
    const entries = [
      { ...item('base', 'V', 30, 7, 10, 124), fontName: 'math' },
      item('left', '(', 39, 4, 10, 116),
      { ...item('inner', 'σ', 45, 8, 10, 124), fontName: 'math' },
      item('right', ')', 55, 4, 10, 116),
      item('article', 'The', 70, 15, 10, 124),
      item('conditional', 'conditional', 90, 48, 10, 124),
      item('variance', 'variance', 143, 36, 10, 124),
      item('verb', 'is', 190, 8, 10, 124),
    ];
    const page = source([previous, ...entries]);
    const atoms = inlineMathAtoms(page, [
      row([previous]),
      row(entries.filter((entry) => !['left', 'right'].includes(entry.id))),
      row(entries.filter((entry) => ['left', 'right'].includes(entry.id))),
    ]);
    expect(atoms).toHaveLength(1);
    expect(atoms[0].sourceIds).toEqual(['base', 'left', 'inner', 'right']);
    expect(atoms[0].baselineY).toBe(124);
  });

  it('keeps a legacy control-code symbol local while the surrounding prose remains text', () => {
    const entries = [
      item('prose', 'The normalized variable is scaled by', 30, 165),
      { ...item('sigma', '\u0005', 200, 4), fontName: 'legacy-symbol' },
      { ...item('variable', 'Y', 206, 6), fontName: 'legacy-symbol' },
      item('tail', 'during the ordinary operating conditions.', 222, 200),
    ];
    const page = source(entries);
    const atoms = inlineMathAtoms(page, [row(entries)]);
    expect(atoms).toHaveLength(1);
    expect(atoms[0].sourceIds).toEqual(['sigma', 'variable']);
    expect(atoms[0].rect.width).toBeLessThan(20);
  });

  it('associates raised delimiter extraction boxes with their supported inline math row', () => {
    const entries = [
      item('prose', 'The quantity is computed using', 30, 165),
      item('left', '(', 205, 4, 10, 85),
      { ...item('sigma', 'σ', 211, 8), fontName: 'legacy-symbol' },
      item('right', ')', 221, 4, 10, 85),
      item('tail', 'and the remaining explanation stays editable.', 240, 210),
    ];
    const page = source(entries);
    const atoms = inlineMathAtoms(page, [row(entries)]);
    expect(atoms).toHaveLength(1);
    expect(atoms[0].sourceIds).toEqual(['left', 'sigma', 'right']);
    expect(atoms[0].rect.y).toBeGreaterThanOrEqual(88);
    expect(atoms[0].sourceIds).not.toContain('prose');
    expect(atoms[0].sourceIds).not.toContain('tail');
  });

  it('does not count word subscripts in a displayed objective as ordinary prose', () => {
    const entries = [
      item('base', 'O(x,t)', 100, 24),
      item('equals', '=', 128, 7),
      item('minimum', 'min', 139, 15),
      item('opening', '(', 154, 4),
      item('first-base', 'Q', 160, 7),
      item('first-script', 'chiller', 167, 21, 7.5, 102),
      item('first-arguments', '(x,t)', 188, 20),
      item('first-plus', '+', 210, 7),
      item('second-base', 'Q', 220, 7),
      item('second-script', 'biogas', 227, 21, 7.5, 102),
      item('second-arguments', '(x,t)', 250, 20),
      item('second-plus', '+', 272, 7),
      item('third-base', 'Q', 282, 7),
      item('third-script', 'boiler', 289, 20, 7.5, 102),
      item('third-arguments', '(x,t))', 311, 25),
    ];
    const page = source(entries);
    expect(inlineMathAtoms(page, [row(page.items)])).toEqual([]);
  });

  it('does not mistake mathematical abbreviations and variables for a prose row', () => {
    const label = item('label', 'WMI', 100, 22);
    const equals = item('equals', '¼', 126, 7);
    const first = item('first', 'w1OEFe', 136, 34);
    const plus = item('plus', 'þ', 173, 7);
    const second = item('second', 'w2OEMe', 183, 37);
    const sigma = item('sigma', '∑', 226, 8);
    const upper = item('upper', '2', 228, 3, 7, 94);
    const lower = item('lower', 'i¼1', 224, 12, 7, 108);
    const variable = item('variable', 'wi', 237, 8);
    const page = source([label, equals, first, plus, second, sigma, upper, lower, variable]);
    expect(inlineMathAtoms(page, [row(page.items)])).toEqual([]);
  });

  it('keeps a zero-advance hat with its overprinted compact variable and trims excess font descent', () => {
    const prose = item('prose', 'The measured value is compared with', 30, 165);
    const accent = { ...item('accent', ' \u0302', 200.7, 0), height: 24, fontName: 'accent' };
    const variable = { ...item('variable', 'yi', 200, 7), fontName: 'italic' };
    const tail = item('tail', 'is the predicted value in the ordinary sentence.', 215, 210);
    const page = source([prose, accent, variable, tail]);
    const atoms = inlineMathAtoms(page, [row(page.items)]);
    expect(atoms).toHaveLength(1);
    expect(atoms[0].sourceIds).toEqual(['accent', 'variable']);
    expect(atoms[0].rect.width).toBeGreaterThanOrEqual(7);
    expect(atoms[0].rect.height).toBeLessThan(16);
    expect(atoms[0].sourceIds).not.toContain('tail');
  });

  it.each(['°', '◦'])(
    'preserves a raised degree mark %s without freezing its prose row',
    (symbol) => {
      const prose = item('prose', 'The office temperature is maintained at 22', 30, 200);
      const degree = item('degree', symbol, 231, 4, 7.5, 96.4);
      const tail = item('tail', 'C during the occupied period of the day.', 237, 190);
      const page = source([prose, degree, tail]);
      const atoms = inlineMathAtoms(page, [row(page.items)]);
      expect(atoms).toHaveLength(1);
      expect(atoms[0].sourceIds).toEqual(['degree']);
      expect(atoms[0].rect.width).toBeLessThan(10);
      expect(atoms[0].baselineY).toBe(100);
    },
  );

  it.each([
    ['<', '⋅'],
    ['>', '·'],
    ['≤', '×'],
    ['≥', '⋅'],
  ])('keeps scientific notation with %s and %s contiguous', (comparison, multiplication) => {
    const prose = item('prose', 'The permutation test reports a probability of', 30, 160);
    const variable = { ...item('p', 'p', 194, 5), fontName: 'italic' };
    const relation = item('relation', comparison, 202, 6);
    const coefficient = item('coefficient', '5', 211, 5);
    const product = item('product', multiplication, 216, 3);
    const base = item('base', '10', 219, 10);
    const minus = item('minus', '\u0000', 229, 1.5, 7.5, 95.5);
    const exponent = item('exponent', '5', 234, 3.5, 7.5, 95.5);
    const tail = item('tail', '), and the ordinary paragraph continues.', 237.5, 190);
    const page = source([
      prose,
      variable,
      relation,
      coefficient,
      product,
      base,
      minus,
      exponent,
      tail,
    ]);
    const atoms = inlineMathAtoms(page, [row(page.items)]);

    expect(atoms).toHaveLength(1);
    expect(atoms[0].sourceIds).toEqual([
      'p',
      'relation',
      'coefficient',
      'product',
      'base',
      'minus',
      'exponent',
      'tail',
    ]);
    expect(atoms[0].spans.at(-1)).toEqual({ sourceId: 'tail', start: 0, end: 1 });
    expect(atoms[0].rect.width).toBeLessThan(50);
    expect(atoms[0].baselineY).toBe(100);
  });

  it('keeps the ink of an unmapped operator wider than its reported advance', () => {
    const prose = item('prose', 'The difference is evaluated using', 30, 130);
    const left = { ...item('left', 'x', 170, 6), fontName: 'math' };
    const minus = item('minus', '\u0000', 180, 2);
    const right = { ...item('right', 'y', 190, 6), fontName: 'math' };
    const tail = item('tail', 'for the remaining ordinary observations.', 210, 210);
    const page = source([prose, left, minus, right, tail]);
    const atoms = inlineMathAtoms(page, [row(page.items)]);
    const expression = atoms.find((atom) => atom.sourceIds.includes('minus'))!;
    expect(expression.sourceIds).toEqual(['left', 'minus', 'right']);
    expect(expression.rect.x + expression.rect.width).toBeGreaterThan(196);
    expect(expression.sourceIds).not.toContain('tail');
  });

  it('bounds an unmapped glyph crop before the following ordinary word', () => {
    const prose = item('prose', 'Ordinary prose precedes the unknown operator', 30, 140);
    const glyph = item('glyph', '\u0000', 180, 2);
    const tail = item('tail', 'following ordinary prose stays separate.', 186, 200);
    const page = source([prose, glyph, tail]);
    const expression = inlineMathAtoms(page, [row(page.items)])[0];
    expect(expression.rect.x + expression.rect.width).toBeGreaterThan(182);
    expect(expression.rect.x + expression.rect.width).toBeLessThan(tail.x);
    expect(expression.sourceIds).toEqual(['glyph']);
  });

  it('keeps a partial prose-run base and its raised exponent together', () => {
    const left = item('left', 'This ordinary prose describes the coefficient (R', 50, 160);
    const exponent = item('power', '2', 210, 4, 7, 96);
    const right = item('right', '). Ordinary prose continues after the expression.', 215, 200);
    const page = source([left, exponent, right]);
    const atoms = inlineMathAtoms(page, [row(page.items)]);
    expect(atoms).toHaveLength(1);
    const atom = atoms[0];
    expect(atom.rect.width).toBeLessThan(30);
    expect(atom.fontSize).toBe(10);
    expect(atom.baselineY).toBe(100);
    const base = atom.spans.find((span) => span.sourceId === 'left')!;
    expect(left.text.slice(base.start, base.end)).toBe('(R');
    const ending = atom.spans.find((span) => span.sourceId === 'right')!;
    expect(right.text.slice(ending.start, ending.end)).toBe(')');
    expect(atom.sourceIds).toContain('power');
  });

  it('groups a base with its comma-separated subscript without absorbing an ordinary word', () => {
    const left = item('prose', 'The actual load is represented by', 50, 130);
    const base = { ...item('base', 'P', 185, 6), fontName: 'italic' };
    const subscript = item('sub', 'd', 191, 4, 7, 102);
    const comma = item('comma', ',', 195, 2, 7, 102);
    const hour = item('hour', 'h', 197, 4, 7, 102);
    const and = item('and', 'and', 204, 16);
    const tail = item('tail', 'the next clause remains ordinary prose.', 224, 160);
    const page = source([left, base, subscript, comma, hour, and, tail]);
    const atoms = inlineMathAtoms(page, [row(page.items)]);
    expect(atoms).toHaveLength(1);
    expect(atoms[0].sourceIds).toEqual(['base', 'sub', 'comma', 'hour']);
    expect(atoms[0].rect.width).toBeLessThan(20);
  });

  it('includes a compact fraction rule with its numerator and denominator', () => {
    const left = item('prose', 'The resulting ratio is computed using', 50, 130);
    const numerator = item('numerator', '1', 185, 4, 6, 94);
    const denominator = { ...item('denominator', 'n', 185, 4, 6, 104), fontName: 'italic' };
    const right = item('right', 'for all observed hours in the experiment.', 198, 190);
    const page = source([left, numerator, denominator, right]);
    page.graphicRegions = [{ x: 183, y: 97, width: 9, height: 0.6 }];
    const atoms = inlineMathAtoms(page, [row(page.items)]);
    expect(atoms).toHaveLength(1);
    expect(atoms[0].sourceIds).toEqual(['numerator', 'denominator']);
    expect(atoms[0].rect.x).toBeLessThanOrEqual(183);
    expect(atoms[0].rect.x + atoms[0].rect.width).toBeGreaterThanOrEqual(192);
  });

  it('does not claim known note references or display-formula members', () => {
    const left = item('prose', 'This normal prose refers to a result', 50, 160);
    const marker = item('note', '2', 210, 4, 6, 96);
    const greek = item('formula', '\u03b1', 235, 7);
    const page = source([left, marker, greek]);
    expect(
      inlineMathAtoms(page, [row(page.items)], new Set(['formula']), new Set(['note'])),
    ).toEqual([]);
  });

  it('keeps separate columns and leaves prose-only paragraphs unchanged', () => {
    const left = item('left', 'Ordinary text fills the left column.', 40, 200);
    const right = item('right', 'Ordinary text fills the right column.', 320, 200);
    const alpha = item('alpha', '\u03b1', 242, 5);
    const beta = item('beta', '\u03b2', 312, 5);
    const page = source([left, right, alpha, beta]);
    const atoms = inlineMathAtoms(page, [row([left, alpha]), row([beta, right])]);
    expect(atoms).toHaveLength(2);
    expect(atoms.every((atom) => atom.rect.width < 10)).toBe(true);
    expect(inlineMathAtoms(source([left, right]), [row([left]), row([right])])).toEqual([]);
  });

  it('rejects headings, rotated text and artifacts', () => {
    const prose = item('prose', 'Ordinary text supplies a body baseline.', 50, 180);
    const heading = { ...item('heading', '\u03b1', 235, 5), structureRoles: ['H2'] };
    const rotated = { ...item('rotated', '\u03b2', 242, 5), preserve: true };
    const artifact = { ...item('artifact', '\u03b3', 250, 5), artifact: true };
    const page = source([prose, heading, rotated, artifact]);
    expect(inlineMathAtoms(page, [row(page.items)])).toEqual([]);
  });

  it('takes a numeric prefix from the following prose without rasterizing the clause', () => {
    const prose = item('prose', 'The operating threshold is defined by', 50, 140);
    const greek = item('greek', '\u03c4', 193, 6);
    const equals = item('equals', '=', 202, 6);
    const right = item('right', '0.9) and the remaining prose continues normally.', 211, 200);
    const page = source([prose, greek, equals, right]);
    const atom = inlineMathAtoms(page, [row(page.items)])[0];
    const span = atom.spans.find((entry) => entry.sourceId === 'right')!;
    expect(right.text.slice(span.start, span.end)).toBe('0.9)');
    expect(atom.rect.width).toBeLessThan(45);
  });

  it.each(['\u0000', '\ufffd'])(
    'preserves an unmapped glyph %j with only the adjacent numeric prefix',
    (glyph) => {
      const prose = item('prose', 'The threshold is approached from below (', 50, 140);
      const minus = item('unmapped-minus', glyph, 193, 1.9925);
      const right = item('right', '0.5%) and past it the normal prose continues.', 194.9925, 200);
      const page = source([prose, minus, right]);
      const atoms = inlineMathAtoms(page, [row(page.items)]);

      expect(atoms).toHaveLength(1);
      expect(atoms[0].sourceIds).toEqual(['unmapped-minus', 'right']);
      expect(atoms[0].spans).toEqual([
        { sourceId: 'unmapped-minus', start: 0, end: 1 },
        { sourceId: 'right', start: 0, end: 4 },
      ]);
      expect(atoms[0].rect.x).toBeLessThan(minus.x);
      expect(atoms[0].rect.width).toBeGreaterThan(minus.width);
      expect(atoms[0].rect.width).toBeLessThan(30);
      expect(right.text.slice(atoms[0].spans[1].end)).toBe(
        ') and past it the normal prose continues.',
      );
    },
  );

  it('keeps ordinary italic words flowing instead of treating the font alone as mathematics', () => {
    const prose = item('prose', 'These normal words describe the result', 50, 150);
    const italic = { ...item('italic', 'when', 204, 20), fontName: 'italic' };
    const ending = item('ending', '(1, 2) are the observations.', 228, 140);
    const page = source([prose, italic, ending]);
    expect(inlineMathAtoms(page, [row(page.items)])).toEqual([]);
  });

  it('merges overlapping full and partial source ranges without duplicate formula text', () => {
    const prose = item('prose', 'The resulting probability is described by', 50, 140);
    const p = { ...item('p', 'p', 193, 6), fontName: 'italic' };
    const equals = item('equals', '=', 202, 6);
    const number = item('number', '0.047).', 211, 30);
    const page = source([prose, p, equals, number]);
    const atom = inlineMathAtoms(page, [row(page.items)])[0];
    expect(atom.spans.filter((span) => span.sourceId === 'number')).toEqual([
      { sourceId: 'number', start: 0, end: number.text.length },
    ]);
  });

  it('associates a raised radical with its radicand rather than the preceding prose row', () => {
    const before = item('before', 'Ordinary prose on the preceding source row.', 50, 300, 10, 100);
    const prose = item('prose', 'The next source row divides by', 50, 140, 10, 111);
    const radical = item('radical', '\u221a', 194, 8, 10, 103.2);
    const base = { ...item('base', 'd', 202, 6, 10, 111), fontName: 'italic' };
    const script = item('subscript', 'k', 208, 4, 7, 112.5);
    const after = item('after', 'and then continues with normal prose.', 216, 180, 10, 111);
    const page = source([before, prose, radical, base, script, after]);
    const atoms = inlineMathAtoms(page, [
      row([before]),
      row([prose, base, script, after]),
      row([radical]),
    ]);
    expect(atoms).toHaveLength(1);
    expect(atoms[0].sourceIds).toEqual(['radical', 'base', 'subscript']);
    expect(atoms[0].baselineY).toBe(111);
    expect(atoms[0].rect.y).toBeGreaterThanOrEqual(102.49);
  });

  it('recognizes prose collectively when a producer emits each ordinary word separately', () => {
    const words = [
      item('energy', 'energy', 50, 30),
      item('with', 'with', 85, 20),
      item('percent', '90%', 110, 18),
      item('round-trip', 'round-trip', 133, 45),
      item('efficiency', 'efficiency', 183, 45),
    ];
    const eta = item('eta', '\u03b7', 234, 6);
    const sub = item('sub', 'c', 240, 4, 7, 102);
    const equals = item('equals', '=', 246, 6);
    const number = item('number', '0.9', 254, 16);
    const page = source([...words, eta, sub, equals, number]);
    const atoms = inlineMathAtoms(page, [row(page.items)]);

    expect(atoms).toHaveLength(1);
    expect(atoms[0].sourceIds).toEqual(['eta', 'sub', 'equals', 'number']);
    expect(atoms[0].rect.width).toBeLessThan(40);
  });

  it('includes closing punctuation in a subscript prefix while leaving the following prose flowing', () => {
    const prose = item('prose', 'The battery power is sized from the peak load (', 50, 140);
    const base = { ...item('base', 'P', 193, 6), fontName: 'italic' };
    const subscriptAndProse = item('subscript', 'max) and two hours in', 199, 90, 7, 102);
    const page = source([prose, base, subscriptAndProse]);
    const atoms = inlineMathAtoms(page, [row(page.items)]);
    expect(atoms).toHaveLength(1);
    expect(atoms[0].spans).toEqual([
      { sourceId: 'base', start: 0, end: 1 },
      { sourceId: 'subscript', start: 0, end: 4 },
    ]);
    expect(subscriptAndProse.text.slice(4)).toBe(' and two hours in');
  });

  it('anchors raised unmapped brackets to adjacent math instead of overlapping preceding prose', () => {
    const before = item(
      'before',
      'Ordinary prose spans the preceding source baseline.',
      50,
      300,
      10,
      100,
    );
    const number = item('number', '0.5', 50, 14, 10, 111);
    const opening = item('opening', '\u0000', 64, 2, 10, 104.5);
    const maximum = item('maximum', 'max', 68, 15, 10, 111);
    const subscript = item('subscript', 'h', 83, 4, 7, 112.5);
    const closing = item('closing', ')', 91, 3, 10, 104.5);
    const tail = item('tail', ', computed over the remaining ordinary prose.', 94, 210, 10, 111);
    const page = source([before, number, opening, maximum, subscript, closing, tail]);
    const atoms = inlineMathAtoms(page, [
      row([before]),
      row([number, maximum, subscript, tail]),
      row([opening, closing]),
    ]);

    expect(atoms).toHaveLength(1);
    expect(atoms[0].sourceIds).toEqual(['number', 'opening', 'maximum', 'subscript', 'closing']);
    expect(atoms[0].baselineY).toBe(111);
    expect(atoms[0].rect.y).toBeGreaterThan(100.8);
    expect(atoms[0].rect.y + atoms[0].rect.height).toBeGreaterThan(114);
  });

  it('keeps a spaced uppercase base with its script in a wrapped mathematical tail', () => {
    const prose = item('prose', 'The representation is computed as a linear function of', 50, 300);
    const base = { ...item('base', 'P E', 50, 16, 10, 111), fontName: 'italic' };
    const sub = item('sub', 'pos', 66, 10, 7, 112.5);
    const dot = item('dot', '.', 77, 2, 10, 111);
    const page = source([prose, base, sub, dot]);
    const atoms = inlineMathAtoms(page, [row([prose]), row([base, sub, dot])]);

    expect(atoms).toHaveLength(1);
    expect(atoms[0].sourceIds).toEqual(['base', 'sub', 'dot']);
    expect(atoms[0].baselineY).toBe(111);
  });

  it.each([
    ['The following equation defines the representation:', 111],
    ['The representation is computed as a linear function of', 121],
  ])('does not promote a separated display after %s', (text, baseline) => {
    const prose = item('prose', text, 50, 300);
    const base = { ...item('base', 'n', 50, 6, 10, baseline), fontName: 'italic' };
    const equals = item('equals', '=', 58, 6, 10, baseline);
    const number = item('number', '4', 66, 5, 10, baseline);
    const page = source([prose, base, equals, number]);
    expect(inlineMathAtoms(page, [row([prose]), row([base, equals, number])])).toEqual([]);
  });

  it('preserves an overprinted tilde with its variable instead of rendering a literal operator', () => {
    const prose = item('prose', 'The resulting vector is denoted by', 50, 140);
    const accent = item('accent', '~', 194, 5);
    const variable = { ...item('variable', 'w', 193, 8), fontName: 'italic' };
    const tail = item('tail', 'and remains within the ordinary paragraph.', 205, 200);
    const page = source([prose, accent, variable, tail]);
    const atoms = inlineMathAtoms(page, [row(page.items)]);
    expect(atoms).toHaveLength(1);
    expect(atoms[0].sourceIds).toEqual(['accent', 'variable']);
    expect(atoms[0].rect.width).toBeLessThan(10);
  });
});
