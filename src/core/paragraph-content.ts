import type { SourceSpan, SourceText } from './model';

interface ItemRange {
  start: number;
  end: number;
  localStart: number;
  item: SourceText;
}
const unspaced = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const normalized = (text: string) => text.normalize('NFKC').replace(/[\s\u00ad]/gu, '');

/** Retain exact source-run offsets while joining the PDF's original visual rows. */
export function paragraphContent(lines: readonly { items: SourceText[] }[]): {
  text: string;
  sourceSpans: SourceSpan[];
  ranges: Map<string, ItemRange>;
} {
  let text = '';
  const ranges = new Map<string, ItemRange>();
  for (const line of lines) {
    let row = '';
    let previous: SourceText | undefined;
    const pieces: { item: SourceText; start: number; end: number }[] = [];
    for (const item of line.items) {
      const gap = previous ? item.x - previous.x - previous.width : 0;
      if (
        previous &&
        (item.spaceBefore || gap > Math.min(item.fontSize, previous.fontSize) * 0.15) &&
        !/\s$/u.test(row) &&
        !/^\s/u.test(item.text)
      )
        row += ' ';
      const start = row.length;
      row += item.text;
      pieces.push({ item, start, end: row.length });
      previous = item;
    }
    const leading = row.length - row.trimStart().length;
    const trailing = row.trimEnd().length;
    const value = row.trim();
    if (!value) continue;
    const connected =
      (unspaced.test(text.slice(-1)) && unspaced.test(value.slice(0, 1))) ||
      (/[\p{L}\p{N}][\-\u2010\u00ad]$/u.test(text) && /^\p{Ll}/u.test(value));
    if (text && !connected) text += ' ';
    const offset = text.length;
    text += value;
    for (const piece of pieces) {
      const localStart = Math.max(0, leading - piece.start);
      const from = Math.max(leading, piece.start);
      const to = Math.min(trailing, piece.end);
      if (to < from) continue;
      ranges.set(piece.item.id, {
        start: offset + from - leading,
        end: offset + to - leading,
        localStart,
        item: piece.item,
      });
    }
  }
  const sourceSpans = [...ranges].map(([sourceId, range]): SourceSpan => {
    let start = normalized(text.slice(0, range.start)).length;
    const end = normalized(text.slice(0, range.end)).length;
    if (start === end && /^\p{Mark}+$/u.test(range.item.text)) start = Math.max(0, end - 1);
    const { x, y, width, height } = range.item;
    return { sourceId, start, end, rect: { x, y, width, height } };
  });
  return { text, sourceSpans, ranges };
}
