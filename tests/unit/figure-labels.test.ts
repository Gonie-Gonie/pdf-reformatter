import { describe, expect, it } from 'vitest';
import { adjacentFigureLabels } from '../../src/core/figure-labels';
import type { Rect, SourceText } from '../../src/core/model';

const figure: Rect = { x: 100, y: 100, width: 200, height: 140 };
function item(id: string, text: string, x: number, y: number, width = text.length * 3): SourceText {
  return {
    id,
    text,
    x,
    y,
    width,
    height: 6,
    fontSize: 6,
    fontName: 'serif EmbeddedChartFont',
    hasEOL: true,
  };
}
function interior(): SourceText[] {
  return [
    item('tick-a', '20', 102, 150),
    item('tick-b', '30', 102, 180),
    item('legend', 'measured', 210, 130),
  ];
}

describe('labels immediately outside a figure', () => {
  it('does not steal a neighboring chapter equation number while retaining a panel label', () => {
    const equation = item('equation', '(18.13)', 75, 160, 21);
    const panel = item('panel', '(1)', 86, 200, 9);
    expect(
      adjacentFigureLabels([...interior(), equation, panel], figure).map((entry) => entry.id),
    ).toEqual(['panel']);
  });

  it('keeps compact two-line side annotations with matching internal label typography', () => {
    const labels = [
      item('side-title', 'output', 78, 130, 17),
      item('side-value', 'size: 112', 75, 137, 22),
      item('next-title', 'output', 78, 180, 17),
      item('next-value', 'size: 56', 77, 187, 20),
    ];
    expect(
      adjacentFigureLabels([...interior(), ...labels], figure).map((entry) => entry.id),
    ).toEqual(labels.map((entry) => entry.id));
  });

  it('includes a rotated y-axis title and a partly overlapping x-axis title', () => {
    const vertical = {
      ...item('vertical', 'error (%)', 88, 155),
      width: 7,
      height: 27,
      preserve: true,
      rotation: -90,
    };
    const horizontal = item('horizontal', 'iter. (1e4)', 170, 239, 32);
    expect(
      adjacentFigureLabels([...interior(), vertical, horizontal], figure).map((entry) => entry.id),
    ).toEqual(['vertical', 'horizontal']);
  });

  it('does not claim captions, notes, different-size prose or distant labels', () => {
    const source = [
      ...interior(),
      item('caption', 'Figure 4. Training curves', 120, 243),
      { ...item('note', '1 Experimental details', 120, 243), structureRoles: ['Note'] },
      { ...item('body', 'We compare both models', 120, 243), fontSize: 10, height: 10 },
      item('sentence', 'These values are similar.', 120, 243),
      item('far', 'Time (s)', 170, 260),
    ];
    expect(adjacentFigureLabels(source, figure)).toEqual([]);
  });

  it('does not grow outward from one newly accepted annotation to another', () => {
    const near = item('near', 'Speed', 82, 150, 14),
      far = item('far', 'Model', 61, 150, 14);
    expect(
      adjacentFigureLabels([...interior(), near, far], figure).map((entry) => entry.id),
    ).toEqual(['near']);
  });

  it('rejects isolated rules and figures without internal font evidence', () => {
    const label = item('label', 'Speed', 120, 112);
    expect(
      adjacentFigureLabels([...interior(), label], { x: 100, y: 100, width: 200, height: 4 }),
    ).toEqual([]);
    expect(adjacentFigureLabels([label], figure)).toEqual([]);
  });

  it('does not bridge an intervening prose run', () => {
    const label = item('label', 'Speed', 70, 150, 23);
    const prose = {
      ...item('prose', 'An intervening paragraph continues on another line.', 91, 146, 7),
      height: 20,
    };
    expect(adjacentFigureLabels([...interior(), label, prose], figure)).toEqual([]);
  });
});
