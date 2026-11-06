import type { SourceText, TextAlignment, TextPlacement, TextSpacing } from './model';

type MeasureText = (text: string, size: number) => number;
const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
const cjk = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]\p{Mark}*$/u;

/** Extra advances belong to gaps, so words and mathematical glyphs are never stretched. */
export function justifyLine(
  text: string,
  width: number,
  size: number,
  measure: MeasureText,
): TextSpacing[] {
  const natural = measure(text, size);
  const remaining = width - natural;
  if (![width, size, natural].every(Number.isFinite) || size <= 0 || remaining <= 0.001) return [];
  let offsets = [...text.matchAll(/[ \t]+/gu)]
    .filter((match) => match.index > 0 && match.index + match[0].length < text.length)
    .map((match) => match.index + match[0].length);
  let maximum = size * 0.6;
  if (!offsets.length) {
    const clusters = [...segmenter.segment(text)];
    offsets = clusters.flatMap((cluster, index) =>
      index < clusters.length - 1 &&
      cjk.test(cluster.segment) &&
      cjk.test(clusters[index + 1].segment)
        ? [cluster.index + cluster.segment.length]
        : [],
    );
    maximum = size * 0.25;
    if (offsets.length < 3) return [];
  }
  if (!offsets.length || remaining / offsets.length > maximum) return [];
  const extra = remaining / offsets.length;
  return offsets.map((after, index) => ({
    after,
    extra: index === offsets.length - 1 ? remaining - extra * index : extra,
  }));
}

function validSpacing(text: string, spacing: readonly TextSpacing[]): TextSpacing[] {
  const boundaries = new Set(
    [...segmenter.segment(text)].map((cluster) => cluster.index + cluster.segment.length),
  );
  const gaps = new Map<number, number>();
  for (const gap of spacing) {
    if (
      gap.after > 0 &&
      gap.after < text.length &&
      boundaries.has(gap.after) &&
      Number.isFinite(gap.extra) &&
      gap.extra > 0
    )
      gaps.set(gap.after, (gaps.get(gap.after) ?? 0) + gap.extra);
  }
  return [...gaps].sort(([a], [b]) => a - b).map(([after, extra]) => ({ after, extra }));
}

/** The export adapter draws each intact chunk, then moves by its extra gap advance. */
export function textSegments(
  text: string,
  spacing: readonly TextSpacing[] = [],
): { text: string; extraAfter: number }[] {
  const result: { text: string; extraAfter: number }[] = [];
  let start = 0;
  for (const gap of validSpacing(text, spacing)) {
    result.push({ text: text.slice(start, gap.after), extraAfter: gap.extra });
    start = gap.after;
  }
  if (start < text.length) result.push({ text: text.slice(start), extraAfter: 0 });
  return result;
}

/** Use the same advances for source anchors, line numbers and clickable note references. */
export function textAdvance(
  placement: Pick<TextPlacement, 'text' | 'fontSize' | 'spacing'>,
  offset: number,
  measure: MeasureText,
): number {
  const end = Math.max(0, Math.min(placement.text.length, Number.isFinite(offset) ? offset : 0));
  return (
    measure(placement.text.slice(0, end), placement.fontSize) +
    validSpacing(placement.text, placement.spacing ?? [])
      .filter((gap) => gap.after <= end)
      .reduce((sum, gap) => sum + gap.extra, 0)
  );
}

interface Row {
  anchor: SourceText;
  left: number;
  right: number;
}

function range(values: number[]): number {
  return Math.max(...values) - Math.min(...values);
}

function distinct(values: number[], tolerance: number): number {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered.reduce<number[]>((result, value) => {
    if (!result.length || value - result[result.length - 1] > tolerance) result.push(value);
    return result;
  }, []).length;
}

/** Trust explicit attributes; infer an edge only when several source rows agree. */
export function inferSourceAlignment(items: readonly SourceText[]): TextAlignment | undefined {
  const explicit = new Set(items.flatMap((item) => (item.alignment ? [item.alignment] : [])));
  if (explicit.size) return explicit.size === 1 ? [...explicit][0] : undefined;
  const text = items.filter(
    (item) =>
      !item.artifact &&
      !item.preserve &&
      item.text.trim().length > 0 &&
      [item.x, item.y, item.width, item.height, item.fontSize].every(Number.isFinite) &&
      item.width > 0 &&
      item.height > 0 &&
      item.fontSize > 0,
  );
  const sizes = text.map((item) => item.fontSize).sort((a, b) => a - b);
  const size = sizes[Math.floor(sizes.length / 2)];
  if (!size) return undefined;
  const rows: Row[] = [];
  const position = (item: SourceText) => item.baselineY ?? item.y + item.height / 2;
  for (const item of text
    .filter((item) => item.fontSize >= size * 0.85)
    .sort((a, b) => position(a) - position(b) || a.x - b.x)) {
    const previous = rows.at(-1);
    if (previous && Math.abs(position(item) - position(previous.anchor)) <= size * 0.3) {
      previous.left = Math.min(previous.left, item.x);
      previous.right = Math.max(previous.right, item.x + item.width);
    } else rows.push({ anchor: item, left: item.x, right: item.x + item.width });
  }
  if (rows.length < 3) return undefined;
  const left = rows.map((row) => row.left);
  const right = rows.map((row) => row.right);
  const widths = rows.map((row) => row.right - row.left);
  if (distinct(widths, size) >= 3) {
    if (
      range(rows.map((row) => (row.left + row.right) / 2)) <= size * 0.4 &&
      range(left) >= size * 2 &&
      range(right) >= size * 2
    )
      return 'center';
    if (range(right) <= size * 0.4 && range(left) >= size * 2) return 'right';
  }
  // Discard the first-line indent and the ragged final line before judging a left edge.
  if (rows.length >= 5) {
    const inner = rows.slice(1, -1);
    if (
      range(inner.map((row) => row.left)) <= size * 0.4 &&
      range(inner.map((row) => row.right)) >= size * 3 &&
      distinct(
        inner.map((row) => row.right),
        size * 0.75,
      ) >= 3
    )
      return 'left';
  }
  return undefined;
}
