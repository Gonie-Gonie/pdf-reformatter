import type { Rect } from '../../core/model';

/** Measure the visible text rectangle in viewport coordinates, including diagram labels. */
export function textGeometry(
  transform: number[],
  advance: number,
  fallbackHeight: number,
  ascent = 0.85,
  descent = -0.2,
): { rect: Rect; fontSize: number; rotation: number; preserve: boolean } {
  const verticalScale = Math.hypot(transform[2], transform[3]);
  const baselineScale = Math.hypot(transform[0], transform[1]);
  const fontSize = verticalScale || fallbackHeight;
  const baseline = baselineScale
    ? [transform[0] / baselineScale, transform[1] / baselineScale]
    : [1, 0];
  const vertical = verticalScale
    ? [transform[2] / verticalScale, transform[3] / verticalScale]
    : [baseline[1], -baseline[0]];
  // Broken font boxes can also report zero/negative ascents for ordinary glyphs.
  // Masking those runs below the baseline leaves their visible ink in figure detection.
  // Normalize the pair before multiplication: even 0 * NaN corrupts x coordinates.
  const validMetrics =
    Number.isFinite(ascent) && Number.isFinite(descent) && ascent > 0 && ascent > descent;
  const fontAscent = validMetrics ? ascent : 0.85;
  const fontDescent = validMetrics ? descent : -0.2;
  const top = fontSize * fontAscent;
  const bottom = fontSize * Math.min(fontDescent, fontAscent - 1);
  const corners = [0, advance].flatMap((distance) =>
    [top, bottom].map((height) => ({
      x: transform[4] + baseline[0] * distance + vertical[0] * height,
      y: transform[5] + baseline[1] * distance + vertical[1] * height,
    })),
  );
  const x = Math.min(...corners.map((point) => point.x));
  const y = Math.min(...corners.map((point) => point.y));
  const rotation = (Math.atan2(baseline[1], baseline[0]) * 180) / Math.PI;
  return {
    rect: {
      x,
      y,
      width: Math.max(...corners.map((point) => point.x)) - x,
      height: Math.max(...corners.map((point) => point.y)) - y,
    },
    fontSize,
    rotation,
    preserve: Math.abs(rotation) > 0.5 || !baselineScale || !verticalScale,
  };
}
