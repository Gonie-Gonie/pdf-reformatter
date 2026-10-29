import { finiteRect } from './geometry';
import type { LayoutDocument, ReadingDocument, Rect, SourceDocument, SourceText } from './model';

export interface PageAnchor {
  page: number;
  rect: Rect;
}

export interface PageLink {
  source: PageAnchor;
  output: PageAnchor;
}

export interface PageLinks {
  bySource: Map<number, PageLink>;
  byOutput: Map<number, PageLink>;
}

interface SourceSpan {
  start: number;
  end: number;
  item: SourceText;
}

interface TextCursor {
  text: string;
  spans: SourceSpan[];
  offset: number;
  dehyphenated?: { text: string; sourceOffsets: number[] };
}

function rectOf(rect: Rect): Rect {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function normalized(text: string): string {
  return text.normalize('NFKC').replace(/[\s\u00ad]/gu, '');
}

function makeCursor(items: SourceText[]): TextCursor {
  const spans: SourceSpan[] = [];
  const parts: string[] = [];
  let length = 0;
  for (const item of items) {
    const text = normalized(item.text);
    if (!text) continue;
    parts.push(text);
    spans.push({ start: length, end: length + text.length, item });
    length += text.length;
  }
  return { text: parts.join(''), spans, offset: 0 };
}

function lowerBound(values: number[], value: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle] < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

function sourceItemAt(cursor: TextCursor, offset: number): SourceText | undefined {
  let low = 0;
  let high = cursor.spans.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (cursor.spans[middle].end <= offset) low = middle + 1;
    else high = middle;
  }
  return cursor.spans[low]?.item;
}

/** Matching advances within each block, so identical lines never jump back to its beginning. */
function locateText(cursor: TextCursor, value: string): Rect | undefined {
  const text = normalized(value);
  if (!text) return undefined;
  let start = cursor.text.indexOf(text, cursor.offset);
  let end = start + text.length;
  if (start < 0) {
    // A removed source line-end hyphen must not break all later anchors in the paragraph.
    if (!cursor.dehyphenated) {
      const sourceOffsets: number[] = [];
      const characters: string[] = [];
      for (let index = 0; index < cursor.text.length; index++) {
        const character = cursor.text[index];
        if (/[-\u2010\u2011]/u.test(character)) continue;
        characters.push(character);
        sourceOffsets.push(index);
      }
      cursor.dehyphenated = { text: characters.join(''), sourceOffsets };
    }
    const target = text.replace(/[-\u2010\u2011]/gu, '');
    if (!target) return undefined;
    const folded = cursor.dehyphenated;
    const offset = lowerBound(folded.sourceOffsets, cursor.offset);
    const match = folded.text.indexOf(target, offset);
    if (match < 0) return undefined;
    start = folded.sourceOffsets[match];
    end = folded.sourceOffsets[match + target.length - 1] + 1;
  }
  cursor.offset = end;
  const item = sourceItemAt(cursor, start);
  return item ? rectOf(item) : undefined;
}

/** Links follow actual placed content rather than equal page numbers or sourcePages sorting. */
export function buildPageLinks(
  source: SourceDocument,
  reading: ReadingDocument,
  layout: LayoutDocument,
): PageLinks {
  const links: PageLinks = { bySource: new Map(), byOutput: new Map() };
  const sourcePages = new Map(source.pages.map((page) => [page.number, page]));
  const sourceItems = new Map(
    source.pages.flatMap((page) => page.items.map((item) => [item.id, item] as const)),
  );
  const blocks = new Map(reading.blocks.map((block) => [block.id, block]));
  const cursors = new Map<string, TextCursor>();
  for (const page of layout.pages) {
    for (const placement of page.placements) {
      if (
        !finiteRect(placement) ||
        placement.decoration ||
        (placement.type === 'text' && !placement.text.trim())
      )
        continue;
      const original = sourcePages.get(placement.sourcePage);
      if (!original) continue;
      let sourceRect: Rect | undefined;
      if (placement.type === 'region') sourceRect = placement.sourceRect;
      else {
        const block = blocks.get(placement.blockId);
        if (block) {
          let cursor = cursors.get(block.id);
          if (!cursor) {
            const items = block.sourceIds
              .map((id) => sourceItems.get(id))
              .filter((item): item is SourceText => item !== undefined);
            cursor = makeCursor(items);
            cursors.set(block.id, cursor);
          }
          const start = placement.textStart;
          const span =
            start === undefined ? undefined : block.sourceSpans?.find((entry) => entry.end > start);
          sourceRect = span?.rect ?? locateText(cursor, placement.text) ?? block.rect;
        }
      }
      sourceRect ??= original.items[0] ?? {
        x: 0,
        y: 0,
        width: original.width,
        height: original.height,
      };
      if (!finiteRect(sourceRect)) continue;
      const link: PageLink = {
        source: { page: placement.sourcePage, rect: rectOf(sourceRect) },
        output: { page: page.number, rect: rectOf(placement) },
      };
      if (!links.byOutput.has(page.number)) links.byOutput.set(page.number, link);
      if (!links.bySource.has(placement.sourcePage)) links.bySource.set(placement.sourcePage, link);
    }
  }
  return links;
}
