import { describe, expect, it } from 'vitest';
import { sharedFigureRegions } from '../../src/core/figure-groups';
import type { SourcePage } from '../../src/core/model';

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
