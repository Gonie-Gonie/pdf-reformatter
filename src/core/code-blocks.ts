import { clampRect, intersects, union } from './geometry';
import type { Rect, SourcePage, SourceText } from './model';

export interface CodeBlockEntry {
  id: string;
  items: SourceText[];
  rect: Rect;
  rawText: string;
}
interface CodeRow extends Rect {
  items: SourceText[];
  text: string;
  size: number;
  baseline: number;
  eligible: boolean;
  numbered: boolean;
  monospaced: boolean;
}
const monospace = /mono|courier|consolas|menlo|inconsolata|source\s*code|liberation\s*mono/iu;
const codeWord =
  /\b(?:def|class|function|return|if|else|elif|for|while|import|from|const|let|var|public|private|protected|static|void|int|double|float|char|bool|using|namespace|try|catch|throw|switch|case|break|continue|select|insert|create)\b/iu;

function median(values: number[]): number {
  const ordered = values
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 2)] ?? 10;
}
function baseline(item: SourceText): number {
  return item.baselineY ?? item.y + item.fontSize * 0.8;
}
function rowText(items: SourceText[], advance: number): string {
  let text = '';
  for (const [index, item] of items.entries()) {
    const previous = items[index - 1];
    if (previous && !/\s$/u.test(text) && !/^\s/u.test(item.text)) {
      const gap = item.x - previous.x - previous.width;
      if (item.spaceBefore || gap > advance * 0.45)
        text += ' '.repeat(Math.max(1, Math.min(40, Math.round(gap / advance))));
    }
    text += item.text;
  }
  return text;
}
function characterAdvance(items: SourceText[]): number {
  return median(
    items
      .filter((item) => monospace.test(item.fontName) && item.text.length > 0)
      .map((item) => item.width / item.text.length),
  );
}
function syntax(text: string): boolean {
  return (
    /[{};]|(?:[<>!=]=)|(?:^|\s)(?:#|\/\/|\/\*)|^\s*(?:>>>|\$\s)/u.test(text) ||
    /[\p{L}_][\p{L}\p{N}_.]*\s*\([^)]*\)/u.test(text) ||
    (codeWord.test(text) && /[:()[\]=]|^\s*(?:return|break|continue)\b/iu.test(text)) ||
    /[\p{L}_][\p{L}\p{N}_.]*(?:\[[^\]]+\])?\s*(?::=|=(?!=)|\+=|-=)/u.test(text)
  );
}

/** Preserve code from the original page: retypesetting cannot reliably recover its indentation. */
export function codeBlockEntries(
  page: SourcePage,
  excludedIds: ReadonlySet<string> = new Set(),
): CodeBlockEntry[] {
  const grouped: SourceText[][] = [];
  for (const item of [...page.items].sort((a, b) => baseline(a) - baseline(b) || a.x - b.x)) {
    const last = grouped.at(-1),
      anchor = last?.[0];
    if (
      anchor &&
      Math.abs(baseline(item) - baseline(anchor)) <=
        Math.max(1, Math.min(item.fontSize, anchor.fontSize) * 0.3)
    )
      last!.push(item);
    else grouped.push([item]);
  }
  const rows: CodeRow[] = [];
  for (const line of grouped) {
    const segments: SourceText[][] = [];
    for (const item of line.sort((a, b) => a.x - b.x)) {
      const current = segments.at(-1),
        previous = current?.at(-1);
      if (
        previous &&
        item.x - previous.x - previous.width <= Math.max(item.fontSize * 4, page.width * 0.06)
      )
        current!.push(item);
      else segments.push([item]);
    }
    for (const items of segments) {
      const size = median(items.map((item) => item.fontSize));
      const mono = items.filter((item) => monospace.test(item.fontName));
      const ordinaryLetters = items.some(
        (item) => !monospace.test(item.fontName) && /\p{L}/u.test(item.text),
      );
      const inDiagram = items.some((item) =>
        page.graphicRegions.some(
          (region) =>
            region.width > size * 2 &&
            region.height > size * 2 &&
            item.x + item.width / 2 > region.x &&
            item.x + item.width / 2 < region.x + region.width &&
            item.y + item.height / 2 > region.y &&
            item.y + item.height / 2 < region.y + region.height,
        ),
      );
      const text = rowText(items, characterAdvance(items)),
        numbered = /^\s*\d{1,4}\s+\S/u.test(text),
        monospaced = mono.length > 0 && !ordinaryLetters;
      rows.push({
        ...union(items),
        items,
        size,
        baseline: baseline(items[0]),
        text,
        numbered,
        monospaced,
        eligible:
          (monospaced || numbered) &&
          !inDiagram &&
          items.every(
            (item) =>
              !excludedIds.has(item.id) &&
              !item.artifact &&
              !item.preserve &&
              Math.abs(item.rotation ?? 0) % 360 < 1,
          ),
      });
    }
  }
  const groups: CodeRow[][] = [];
  for (const row of rows.sort((a, b) => a.baseline - b.baseline || a.x - b.x)) {
    if (!row.eligible) continue;
    const group = groups.findLast((candidate) => {
      const previous = candidate.at(-1)!;
      const size = Math.max(row.size, previous.size),
        gap = row.baseline - previous.baseline;
      if (
        gap < size * 0.5 ||
        gap > size * 2.8 ||
        Math.abs(row.size - previous.size) > size * 0.15 ||
        Math.abs(row.x - Math.min(...candidate.map((entry) => entry.x))) > size * 12
      )
        return false;
      const previousRect = union(candidate);
      if (
        row.x > previousRect.x + previousRect.width + size * 1.5 ||
        row.x + row.width < previousRect.x - size * 1.5
      )
        return false;
      const envelope = union([...candidate, row]);
      return !rows.some(
        (other) =>
          !other.eligible &&
          other.baseline > previous.baseline &&
          other.baseline < row.baseline &&
          intersects(envelope, other),
      );
    });
    if (group) group.push(row);
    else groups.push([row]);
  }
  return groups.flatMap((lines) => {
    if (lines.length < 2) return [];
    if (lines.some((line) => !line.monospaced)) {
      const numbers = lines.map((line) => Number(/^\s*(\d+)\s/u.exec(line.text)?.[1]));
      const declaration = lines.some((line) =>
        /^\s*\d+\s+(?:partial\s+)?(?:connector|model|function|class|def|extends|parameter|flow)\b/iu.test(
          line.text,
        ),
      );
      if (
        lines.length < 4 ||
        !lines.every((line) => line.numbered) ||
        numbers.some(
          (number, index) =>
            !Number.isInteger(number) || (index > 0 && number !== numbers[index - 1] + 1),
        ) ||
        !declaration
      )
        return [];
    }
    const syntaxLines = lines.filter((line) => syntax(line.text));
    const numericOutput =
      lines.length >= 3 &&
      lines.filter((line) => /^\s*[-+]?\d+(?:\.\d+)?\s*$/u.test(line.text)).length >= 2 &&
      lines.some((line) => /\p{L}/u.test(line.text)) &&
      lines.every((line) => line.text.trim().length <= 40 && !/[.!?]\s+\p{L}/u.test(line.text));
    if (syntaxLines.length < 2 && !numericOutput) return [];
    const items = lines.flatMap((line) => line.items),
      content = union(items),
      size = median(lines.map((line) => line.size)),
      edge = Math.min(2, size * 0.15),
      advance = characterAdvance(items);
    const rect = clampRect(
      {
        x: content.x - edge,
        y: content.y - edge,
        width: content.width + edge * 2,
        height: content.height + edge * 2,
      },
      page.width,
      page.height,
    );
    // A crop must never silently duplicate nearby prose or another already-owned structure.
    const ids = new Set(items.map((item) => item.id));
    if (page.items.some((item) => !ids.has(item.id) && intersects(rect, item))) return [];
    return [
      {
        id: items[0].id,
        items,
        rect,
        rawText: lines
          .map((line, index) => {
            const indentation = Math.max(
              0,
              Math.min(80, Math.round((line.x - content.x) / advance)),
            );
            const blank =
              index > 0 && line.baseline - lines[index - 1].baseline > size * 1.8 ? '\n' : '';
            return blank + ' '.repeat(indentation) + line.text;
          })
          .join('\n'),
      },
    ];
  });
}
