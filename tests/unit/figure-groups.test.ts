import { describe, expect, it } from 'vitest';
import { sharedFigureRegions } from '../../src/core/figure-groups';
import type { SourcePage, SourceText } from '../../src/core/model';

function line(text: string, x: number, y: number, width: number, fontSize = 10) {
  return { text, rect: { x, y, width, height: fontSize }, fontSize };
}

function page(): SourcePage {
  return {
    number: 4,
    width: 612,
    height: 792,
    rotation: 0,
    warnings: [],
    items: [],
    graphicRegions: [
      { x: 346, y: 82, width: 122, height: 158 },
      { x: 173, y: 92, width: 68, height: 129 },
    ],
  };
}

function lines() {
  return [
    line('Scaled Dot-Product Attention', 148, 72, 118),
    line('Multi-Head Attention', 364, 72, 87),
    line('Figure 2: (left) Scaled attention. (right) Several attention layers', 108, 275, 396),
    line('running in parallel.', 108, 286, 140),
    line('A separate body paragraph follows the figure caption.', 108, 318, 396),
  ];
}

describe('figures with a shared panel caption', () => {
  it('binds full-width chart axes and legends to a shorter centered caption', () => {
    const source = page();
    source.graphicRegions = [
      { x: 104, y: 354, width: 422, height: 155 },
      { x: 76, y: 386, width: 14, height: 89 },
      { x: 332, y: 530, width: 10, height: 41 },
      { x: 413, y: 530, width: 10, height: 41 },
      { x: 107, y: 535, width: 10, height: 41 },
      { x: 198, y: 535, width: 10, height: 41 },
    ];
    const caption = line(
      'FIGURE 20: Shared energy through (a) ferries and (b) cars.',
      161,
      598,
      277,
      9,
    );
    const labels = [
      line('Shared energy', 76, 386, 14, 9),
      line('Ferry-S1 Ferry-S2', 118, 536, 150, 7),
      line('Car-S1 Car-S2', 343, 531, 150, 7),
      line('(a)', 185, 582, 10, 9),
      line('(b)', 460, 582, 10, 9),
    ];
    const regions = sharedFigureRegions(source, [...labels, caption]);
    expect(regions).toHaveLength(1);
    expect(regions[0].rect.x).toBeLessThanOrEqual(76);
    expect(regions[0].rect.x + regions[0].rect.width).toBeGreaterThanOrEqual(526);
    expect(regions[0].rect.y + regions[0].rect.height).toBeGreaterThanOrEqual(591);
    expect(regions[0].rect.y + regions[0].rect.height).toBeLessThan(598);
    expect(
      sharedFigureRegions(source, [...labels, { ...caption, rect: { ...caption.rect, x: 10 } }]),
    ).toEqual([]);
  });

  it('retains matching diagram labels when a book figure has a side caption', () => {
    const source = page();
    source.graphicRegions = [{ x: 92, y: 70, width: 161, height: 198 }];
    source.items = [
      ['Root choices', 64, 145, 50],
      ['Overlapping branches', 237, 165, 73],
      ['Developing areas', 230, 238, 65],
      ['Hierarchy questions', 112, 269, 72],
      ['The ordinary paragraph begins after this diagram.', 64, 310, 280],
    ].map(([value, x, y, width], index) => ({
      id: `diagram-${index}`,
      text: value as string,
      x: x as number,
      y: y as number,
      width: width as number,
      height: 8,
      fontSize: 8,
      fontName: 'diagram',
      hasEOL: true,
    }));
    const caption = line('Figure 3.10 Functional decomposition challenges.', 326, 71, 82, 8.5);
    const regions = sharedFigureRegions(source, [caption]);
    expect(regions).toHaveLength(1);
    expect(regions[0].rect.x).toBeLessThanOrEqual(64);
    expect(regions[0].rect.x + regions[0].rect.width).toBeGreaterThanOrEqual(310);
    expect(regions[0].rect.y + regions[0].rect.height).toBeGreaterThanOrEqual(277);
    expect(regions[0].rect.y + regions[0].rect.height).toBeLessThan(310);
    source.items = source.items.slice(0, 2);
    expect(sharedFigureRegions(source, [caption])).toEqual([]);
  });

  it('keeps chapter-numbered chart ticks and panel labels inside one connected plot', () => {
    const source = page();
    source.graphicRegions = [{ x: 55, y: 498, width: 327, height: 51 }];
    const labels = [
      ...Array.from({ length: 24 }, (_, index) =>
        line(((index % 12) / 10).toFixed(1), 70 + index * 13, 551, 8, 5.2),
      ),
      line('Load ratio [-]', 160, 557, 50, 5.2),
      line('a)', 62, 560, 8, 10),
      line('b)', 230, 560, 8, 10),
    ];
    source.items = labels.map((label, index) => ({
      id: `tick-${index}`,
      ...label.rect,
      text: label.text,
      fontSize: label.fontSize,
      fontName: 'chart',
      baselineY: label.rect.y + label.fontSize * 0.8,
      hasEOL: true,
    }));
    const caption = line('Fig. 7.8 COPs at different load ratios.', 54, 584, 303, 8.5);
    const body = line('A normal paragraph follows the figure.', 54, 610, 330, 10);
    const regions = sharedFigureRegions(source, [...labels, caption, body]);
    expect(regions).toHaveLength(1);
    expect(regions[0].rect.y + regions[0].rect.height).toBeGreaterThanOrEqual(570);
    expect(regions[0].rect.y + regions[0].rect.height).toBeLessThan(584);
    source.items = [];
    expect(sharedFigureRegions(source, [caption, body])).toEqual([]);
  });

  it('keeps a wide chart and its rotated axis beside a short left-aligned book caption', () => {
    const source = { ...page(), width: 440 };
    source.graphicRegions = [
      { x: 87, y: 58, width: 298, height: 191 },
      { x: 55, y: 106, width: 11, height: 73 },
    ];
    const caption = line('Fig. 9.20 Relative error.', 54, 264, 128, 8.5);
    const body = line('A full paragraph starts below the figure caption.', 54, 300, 330, 10);
    const regions = sharedFigureRegions(source, [caption, body]);
    expect(regions).toHaveLength(1);
    expect(regions[0].rect.x).toBe(53);
    expect(regions[0].rect.x + regions[0].rect.width).toBe(387);
    expect(regions[0].rect.y + regions[0].rect.height).toBeLessThan(264);
    expect(
      sharedFigureRegions(source, [{ ...caption, rect: { ...caption.rect, x: 250 } }, body]),
    ).toEqual([]);
  });

  it('recognizes a decimal book caption with explicit Left and Right panel references', () => {
    const source = page();
    source.graphicRegions = [
      { x: 60, y: 80, width: 140, height: 120 },
      { x: 240, y: 80, width: 140, height: 120 },
      { x: 70, y: 225, width: 10, height: 20 },
      { x: 250, y: 225, width: 10, height: 20 },
    ];
    const caption = line(
      'Fig. 2.16 Left regression analyses and Right optimization paths.',
      54,
      270,
      331,
      8.5,
    );
    const labels = [line('Series 1', 82, 226, 50, 6), line('Series 2', 262, 226, 50, 6)];
    const regions = sharedFigureRegions(source, [...labels, caption]);
    expect(regions).toHaveLength(1);
    expect(regions[0].rect.y + regions[0].rect.height).toBeGreaterThanOrEqual(245);
    expect(regions[0].rect.y + regions[0].rect.height).toBeLessThan(270);
    expect(
      sharedFigureRegions(source, [
        ...labels,
        { ...caption, text: 'Fig. 2.16 A description without shared panel evidence.' },
      ]),
    ).toEqual([]);
  });

  it('keeps a narrow centered chart with labeled detached swatches under a full-width caption', () => {
    const source = page();
    source.graphicRegions = [
      { x: 218, y: 70, width: 195, height: 161 },
      { x: 189, y: 99, width: 14, height: 101 },
      { x: 221, y: 257, width: 10, height: 20 },
      { x: 316, y: 257, width: 10, height: 10 },
    ];
    const labels = [
      line('RE1 RE2 RE3 RE4 RE5 RE6 RE7', 230, 232, 175, 8),
      line('Renewable energy combination', 267, 243, 101, 8),
      line('20%', 232, 258, 14, 8),
      line('30%', 232, 269, 14, 8),
      line('40%', 328, 258, 14, 8),
      line('(c)', 295, 282, 12, 9),
    ];
    source.items = labels.map((label, index) => ({
      id: `label-${index}`,
      ...label.rect,
      text: label.text,
      fontSize: label.fontSize,
      fontName: 'chart',
      baselineY: label.rect.y + label.fontSize * 0.8,
      hasEOL: true,
    }));
    const caption = line(
      'FIGURE 14: Research combination under several control scenarios.',
      50,
      300,
      500,
      9,
    );
    const after = line('An ordinary paragraph follows the complete chart.', 50, 340, 500, 10);
    const regions = sharedFigureRegions(source, [...labels, caption, after]);
    expect(regions).toHaveLength(1);
    expect(regions[0].rect.x).toBeLessThanOrEqual(189);
    expect(regions[0].rect.x + regions[0].rect.width).toBeGreaterThanOrEqual(413);
    expect(regions[0].rect.y + regions[0].rect.height).toBeGreaterThanOrEqual(291);
    expect(regions[0].rect.y + regions[0].rect.height).toBeLessThan(300);

    // Small unrelated fragments alone do not relax the caption-width safeguard.
    source.items = [];
    expect(sharedFigureRegions(source, [caption, after])).toEqual([]);
  });

  it('uses original chart labels when gutter inference mixes a rotated axis with neighboring prose', () => {
    const source = page();
    source.graphicRegions = [
      { x: 77, y: 466, width: 195, height: 138 },
      { x: 76, y: 630, width: 17, height: 22 },
      { x: 184, y: 630, width: 18, height: 22 },
    ];
    const item = (
      id: string,
      text: string,
      x: number,
      y: number,
      width: number,
      size = 8,
    ): SourceText => ({
      id,
      text,
      x,
      y,
      width,
      height: size,
      fontSize: size,
      fontName: 'chart',
      baselineY: y + size * 0.8,
      hasEOL: true,
    });
    const axis = {
      ...item('axis', 'Monthly solar radiation', 50, 469, 12, 12),
      height: 132,
      preserve: true,
      rotation: -90,
    };
    const body = item(
      'body',
      'The building models consist of two floors and remain ordinary text.',
      309,
      540,
      241,
      10,
    );
    source.items = [
      axis,
      {
        ...item('right-axis', 'Monthly wind velocity', 280, 474, 12, 12),
        height: 122,
        preserve: true,
        rotation: -90,
      },
      ...'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'
        .split(' ')
        .map((text, index) => item(`month-${index}`, text, 85 + index * 15, 605, 12)),
      item('legend-a', 'Solar radiation HK', 95, 632, 61),
      item('legend-b', 'Solar radiation MO', 203, 632, 63),
      item('legend-c', 'Wind velocity HK(Y-axis)', 95, 643, 84),
      item('legend-d', 'Wind velocity MO(Y-axis)', 203, 643, 86),
      body,
    ];
    const regions = sharedFigureRegions(source, [
      {
        ...line(
          'Monthly solar radiation The building models consist of two floors and remain ordinary text.',
          50,
          540,
          500,
          12,
        ),
        items: [axis, body],
      },
      line('FIGURE 2: Monthly solar radiation and wind velocity.', 50, 660, 241, 9),
    ]);
    expect(regions).toHaveLength(1);
    const rect = regions[0].rect;
    expect(rect.x).toBeLessThanOrEqual(50);
    expect(rect.x + rect.width).toBeGreaterThanOrEqual(292);
    expect(rect.x + rect.width).toBeLessThan(300);
    expect(rect.y + rect.height).toBeGreaterThanOrEqual(652);
    expect(rect.y + rect.height).toBeLessThan(660);
  });

  it('keeps an unboxed vector plot, detached legend columns and rotated axis together', () => {
    const source = page();
    source.graphicRegions = [
      { x: 174, y: 67, width: 285, height: 231 },
      { x: 175, y: 328, width: 18, height: 16 },
      { x: 316, y: 338, width: 18, height: 27 },
      { x: 175, y: 359, width: 18, height: 27 },
      { x: 316, y: 381, width: 18, height: 5 },
      { x: 48, y: 443, width: 505, height: 6 },
    ];
    const labels = [
      line('G_RE-S1 Shortage-S2', 198, 325, 174, 12),
      line('Surplus-S1 Demand-S2', 198, 338, 174, 12),
      line('Demand-S1 G_RE-S3', 198, 365, 174, 12),
      {
        text: 'Electric power (kW)',
        rect: { x: 135, y: 148, width: 12, height: 70 },
        fontSize: 12,
      },
      line(
        'FIGURE 21: Duration curves of renewable energy generation and demand.',
        74,
        397,
        450,
        9,
      ),
      line('TABLE 13: Results of the selected cases.', 178, 431, 243, 9),
    ];
    const regions = sharedFigureRegions(source, labels);
    expect(regions).toHaveLength(1);
    const rect = regions[0].rect;
    expect(rect.x).toBeLessThanOrEqual(135);
    expect(rect.y).toBeLessThanOrEqual(67);
    expect(rect.x + rect.width).toBeGreaterThanOrEqual(459);
    expect(rect.y + rect.height).toBeGreaterThanOrEqual(386);
    expect(rect.y + rect.height).toBeLessThan(397);
  });

  it('groups vertically stacked flowchart panels under their common a/b caption', () => {
    const source = page();
    source.graphicRegions = [
      { x: 57, y: 68, width: 486, height: 182 },
      { x: 57, y: 270, width: 486, height: 298 },
    ];
    const regions = sharedFigureRegions(source, [
      line(
        'If there is enough charging capacity then proceed to the next internal decision.',
        90,
        100,
        400,
        9,
      ),
      line('(a)', 293, 251, 10, 9),
      line('(b)', 293, 574, 10, 9),
      line(
        'FIGURE 7: Energy flow with (a) vehicle-to-building and (b) building-to-vehicle.',
        94,
        587,
        411,
        9,
      ),
    ]);
    expect(regions).toHaveLength(1);
    expect(regions[0].rect.y).toBe(66);
    expect(regions[0].rect.y + regions[0].rect.height).toBeGreaterThanOrEqual(583);
    expect(regions[0].rect.y + regions[0].rect.height).toBeLessThan(587);
  });

  it.each([
    'An unrelated paragraph with enough ordinary words is located between these two drawings.',
    'Figure 2: A separate preceding figure.',
    'TABLE 2: A separate table.',
  ])('does not bridge a caption-scoped plot across %s', (between) => {
    const source = page();
    source.graphicRegions = [
      { x: 100, y: 100, width: 200, height: 150 },
      { x: 120, y: 280, width: 100, height: 15 },
    ];
    expect(
      sharedFigureRegions(source, [
        line(between, 100, 260, 260, 9),
        line('FIGURE 3: A plot with a legend.', 80, 310, 300, 9),
      ]),
    ).toEqual([]);
  });

  it('leaves a single connected illustration with its existing source boundary', () => {
    const source = page();
    source.graphicRegions = [{ x: 100, y: 100, width: 200, height: 150 }];
    expect(
      sharedFigureRegions(source, [
        line('FIGURE 3: An existing complete bitmap.', 80, 270, 300, 9),
      ]),
    ).toEqual([]);
  });

  it('does not rejoin a separate running logo to the nearby captioned bitmap', () => {
    const source = page();
    source.graphicRegions = [
      { x: 77, y: 23, width: 15, height: 15 },
      { x: 95, y: 48, width: 419, height: 242 },
    ];
    source.items = [
      {
        id: 'folio',
        text: '684',
        x: 60,
        y: 27,
        width: 12,
        height: 7.5,
        fontSize: 7.5,
        fontName: 'sans',
        hasEOL: false,
      },
      {
        id: 'running-author',
        text: 'K. TANG',
        x: 97,
        y: 27,
        width: 25,
        height: 7.5,
        fontSize: 7.5,
        fontName: 'sans',
        hasEOL: false,
      },
    ];
    expect(
      sharedFigureRegions(source, [
        line('Figure 1. A complete schematic diagram.', 60, 309, 440, 9.5),
      ]),
    ).toEqual([]);
  });

  it('keeps both panels, their titles and the full shared caption in one crop', () => {
    const source = page();
    const before = JSON.stringify(source);
    const regions = sharedFigureRegions(source, lines());
    expect(regions).toHaveLength(1);
    expect(regions[0].rect).toEqual({ x: 106, y: 70, width: 400, height: 228 });
    expect(JSON.stringify(source)).toBe(before);
  });

  it('supports a shared a/b caption whose references wrap onto the next line', () => {
    const caption = lines();
    caption[2].text = 'Figure 2: (a) First panel, compared with the second panel';
    caption[3].text = '(b) shown on the right.';
    expect(sharedFigureRegions(page(), caption)).toHaveLength(1);
  });

  it('can include panel titles emitted as a single row', () => {
    const caption = lines().slice(2);
    caption.unshift(line('Scaled Dot-Product Attention Multi-Head Attention', 148, 72, 303));
    expect(sharedFigureRegions(page(), caption)[0].rect.y).toBe(70);
  });

  it('does not group adjacent figures without explicit shared panel references', () => {
    const caption = lines();
    caption[2].text = 'Figure 2: An attention layer.';
    expect(sharedFigureRegions(page(), caption)).toEqual([]);
  });

  it('rejects unrelated prose in the gap between a graphic and the shared caption', () => {
    const caption = lines();
    caption.splice(
      2,
      0,
      line(
        'A separate body paragraph with enough words to distinguish ordinary flowing prose from short panel labels.',
        108,
        250,
        396,
      ),
    );
    expect(sharedFigureRegions(page(), caption)).toEqual([]);
  });

  it('does not absorb a neighboring independent figure caption', () => {
    const caption = lines();
    caption.splice(2, 0, line('Figure 1: A different experiment.', 173, 230, 210));
    expect(sharedFigureRegions(page(), caption)).toEqual([]);
  });

  it('requires side-by-side, vertically aligned panels and a shared spanning caption', () => {
    const stacked = page();
    stacked.graphicRegions[1] = { x: 346, y: 20, width: 122, height: 40 };
    expect(sharedFigureRegions(stacked, lines())).toEqual([]);
    const narrow = lines();
    narrow[2].rect.width = 180;
    expect(sharedFigureRegions(page(), narrow)).toEqual([]);
  });

  it('retains compact extracted labels within and between the panels', () => {
    const caption = lines();
    caption.splice(2, 0, line('Query', 175, 205, 30), line('(a)', 275, 235, 10));
    expect(sharedFigureRegions(page(), caption)).toHaveLength(1);
  });
});
