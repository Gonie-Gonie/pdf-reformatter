import english from 'hyphen/en-us';

type MeasureText = (text: string, size: number) => number;
const softHyphen = '\u00ad';
const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const openingPunctuation = /[(\[\u3008\u300a\u300c\u300e\uff08]$/u;
const closingPunctuation =
  /^[,.;:!?\u3001\u3002\uff0c\uff0e\uff01\uff1f\u300d\u300f\u300b\u3009\uff09\]\)]/u;

/** Dictionary-derived discretionary breaks; never reinterpret acronyms, URLs or formula symbols. */
export function hyphenationPoints(word: string): number[] {
  if (!/^(?:[a-z]{6,}|[A-Z][a-z]{5,})$/u.test(word)) return [];
  const parts = english.hyphenateSync(word).split(softHyphen);
  const result: number[] = [];
  let offset = 0;
  for (const part of parts.slice(0, -1)) {
    offset += part.length;
    if (offset >= 3 && offset <= word.length - 3) result.push(offset);
  }
  return result;
}

interface BreakPoint {
  end: number;
  next: number;
  hyphen: boolean;
  penalty: number;
}
interface Choice {
  cost: number;
  point?: BreakPoint;
}

function firstAtLeast(values: readonly number[], target: number): number {
  let low = 0,
    high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function sourceParagraph(raw: string): { text: string; soft: number[] } {
  let text = '';
  const soft: number[] = [];
  for (const character of raw.trim().replace(/[ \t]+/gu, ' ')) {
    if (character === softHyphen) soft.push(text.length);
    else text += character;
  }
  return { text, soft };
}

/** Fit the whole paragraph, rather than accepting a very loose line and abandoning justification. */
export function wrapParagraph(
  raw: string,
  width: number,
  size: number,
  measure: MeasureText,
): string[] {
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(size) || size <= 0)
    throw new RangeError('Invalid paragraph width or font size.');
  const measured = new Map<string, number>();
  const advance = (text: string) => {
    const display = text.replace(/\u00ad/gu, '-');
    const cached = measured.get(display);
    if (cached !== undefined) return cached;
    const value = measure(display, size);
    if (!Number.isFinite(value) || value < 0) throw new RangeError('Invalid text measurement.');
    measured.set(display, value);
    return value;
  };
  const result: string[] = [];
  for (const rawParagraph of raw.replace(/\r\n?/gu, '\n').split('\n')) {
    if (!rawParagraph.trim()) {
      if (result.length) result.push('');
      continue;
    }
    const { text, soft } = sourceParagraph(rawParagraph);
    if (!text) continue;
    if (advance(text) <= width + 0.001) {
      result.push(text);
      continue;
    }
    const opportunities = new Map<string, BreakPoint>();
    const add = (point: BreakPoint) => {
      if (point.end <= 0 || point.end >= text.length) return;
      const key = `${point.end}:${point.next}`;
      const previous = opportunities.get(key);
      if (!previous || point.penalty < previous.penalty) opportunities.set(key, point);
    };
    for (const match of text.matchAll(/ +/gu))
      add({ end: match.index, next: match.index + match[0].length, hyphen: false, penalty: 0 });
    for (const offset of soft)
      if (/\p{Letter}/u.test(text[offset - 1] ?? '') && /\p{Letter}/u.test(text[offset] ?? ''))
        add({ end: offset, next: offset, hyphen: true, penalty: 8 });
    for (const match of text.matchAll(/\S+/gu)) {
      const word = match[0],
        start = match.index;
      const ordinary = /^(["'\u2018\u201c(\[]*)([A-Za-z]{6,})(["'\u2019\u201d),.;:!?\]]*)$/u.exec(
        word,
      );
      if (ordinary)
        for (const offset of hyphenationPoints(ordinary[2])) {
          const end = start + ordinary[1].length + offset;
          add({ end, next: end, hyphen: true, penalty: 15 });
        }
      for (const hyphen of word.matchAll(/[-\u2010]/gu)) {
        const end = start + hyphen.index + 1;
        if (hyphen.index && end < start + word.length)
          add({ end, next: end, hyphen: false, penalty: 8 });
      }
      const clusters = [...segmenter.segment(word)];
      const oversized = advance(word) > width + 0.001;
      for (let index = 1; index < clusters.length; index++) {
        const previous = clusters[index - 1].segment,
          current = clusters[index].segment;
        if (openingPunctuation.test(previous) || closingPunctuation.test(current)) continue;
        const end = start + clusters[index].index;
        if (cjk.test(previous) || cjk.test(current))
          add({ end, next: end, hyphen: false, penalty: 0 });
        else if (oversized) add({ end, next: end, hyphen: false, penalty: 100_000 });
      }
    }
    const points = [
      ...opportunities.values(),
      { end: text.length, next: text.length, hyphen: false, penalty: 0 },
    ].sort((a, b) => a.end - b.end || a.next - b.next);
    const pointEnds = points.map((point) => point.end);
    const starts = [...new Set([0, ...points.map((point) => point.next)])].sort((a, b) => b - a);
    const words = [...text.matchAll(/\S+/gu)].map((match) => ({
      start: match.index,
      end: match.index + match[0].length,
      width: advance(match[0]),
    }));
    const wordEnds = words.map((word) => word.end);
    const space = advance(' ');
    const prefix = [0];
    for (const word of words) prefix.push(prefix[prefix.length - 1] + word.width + space);
    const clusters = [...segmenter.segment(text)];
    const cjkBoundaries = clusters.flatMap((cluster, index) =>
      index && cjk.test(cluster.segment) && cjk.test(clusters[index - 1].segment)
        ? [cluster.index]
        : [],
    );
    const lineText = (start: number, point: BreakPoint) =>
      text.slice(start, point.end) + (point.hyphen ? softHyphen : '');
    const plansFor = (exact: boolean) => {
      const plans = new Map<number, [Choice, Choice]>();
      plans.set(text.length, [{ cost: 0 }, { cost: 0 }]);
      for (const start of starts) {
        if (start === text.length) continue;
        const choices: [Choice, Choice] = [{ cost: Infinity }, { cost: Infinity }];
        const firstWord = firstAtLeast(wordEnds, start + 1);
        for (let index = firstAtLeast(pointEnds, start + 1); index < points.length; index++) {
          const point = points[index];
          const lastWord = firstAtLeast(wordEnds, point.end);
          const spaces = lastWord - firstWord;
          // PDF glyph advances are additive across spaces. Cache intact words and only
          // shape the two boundary fragments instead of reshaping every candidate line.
          const natural =
            exact || firstWord === lastWord
              ? advance(lineText(start, point))
              : advance(text.slice(start, words[firstWord].end)) +
                space +
                prefix[lastWord] -
                prefix[firstWord + 1] +
                advance(
                  text.slice(words[lastWord].start, point.end) + (point.hyphen ? softHyphen : ''),
                );
          if (natural > width + 0.001) break;
          const following = plans.get(point.next);
          if (!following) continue;
          const final = point.end === text.length;
          const gaps =
            spaces ||
            firstAtLeast(cjkBoundaries, point.end) - firstAtLeast(cjkBoundaries, start + 1);
          const extra = Math.max(0, width - natural) / Math.max(1, gaps);
          const hyphenated = point.hyphen || /[-\u2010]/u.test(text[point.end - 1]);
          const base = final
            ? start > 0 && natural < width * 0.22
              ? 15
              : 0
            : 20 + 40 * (extra / size) ** 2 + (gaps ? 0 : 120) + point.penalty;
          for (const previousHyphen of [0, 1] as const) {
            const cost =
              base +
              following[hyphenated ? 1 : 0].cost +
              (previousHyphen && hyphenated && !final ? 30 : 0);
            if (cost < choices[previousHyphen].cost) choices[previousHyphen] = { cost, point };
          }
        }
        plans.set(start, choices);
      }
      const lines: string[] = [];
      let position = 0,
        previousHyphen = false;
      while (position < text.length) {
        const point: BreakPoint | undefined = plans.get(position)?.[previousHyphen ? 1 : 0].point;
        if (!point) return;
        const line = lineText(position, point);
        if (advance(line) > width + 0.001) return;
        lines.push(line);
        position = point.next;
        previousHyphen = point.hyphen || /[-\u2010]$/u.test(line);
      }
      return lines;
    };
    // A caller with contextual, non-additive measurements still gets exact fitted rows.
    const lines = plansFor(false) ?? plansFor(true);
    if (!lines) throw new RangeError('A glyph does not fit the paragraph width.');
    result.push(...lines);
  }
  return result;
}
