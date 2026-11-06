import { clampRect, intersects, union } from './geometry';
import { codeBlockEntries } from './code-blocks';
import { findColumnGutter } from './columns';
import type {
  ReadingBlock,
  ReadingReference,
  Rect,
  SourceDocument,
  SourcePage,
  SourceSpan,
  SourceStructure,
  SourceText,
} from './model';

interface Row {
  items: SourceText[];
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  size: number;
}
export interface PendingLineNumber {
  item: SourceText;
  targetId?: string;
  targetRect?: Rect;
}
export interface PageSemantics {
  blocks: ReadingBlock[];
  lineNumbers: PendingLineNumber[];
  referenceIds: Set<string>;
}
const noteRoles = new Set(['Note', 'FENote']);
const contentsHeading = /^(?:table\s+of\s+contents|contents|목\s*차)\s*$/iu;
const indexHeading =
  /^[\p{Cc}\s]*(?:\d+[\p{Cc}\s]+)?(?:index|subject\s+index|색\s*인|찾아보기)(?:\s+\d+)?[\p{Cc}\s]*$/iu;
const notesHeading = /^(?:endnotes?|footnotes?|notes|미주|각주|주석)\s*$/iu;
const pageNumber = /^(?:\d{1,5}|[ivxlcdm]{1,10})(?:\s*[,–—-]\s*(?:\d{1,5}|[ivxlcdm]{1,10}))*$/iu;

export function normalizedSourceText(text: string): string {
  return text.normalize('NFKC').replace(/[\s\u00ad]/gu, '');
}
function hasTocLeader(text: string): boolean {
  const normalized = text.replace(/(?:\.\s*){2,}/gu, '...');
  return /(?:\.{2,}|…|·{3,})\s*(?:\d+|[ivxlcdm]+)\s*$/iu.test(normalized);
}
function startsTocEntry(text: string): boolean {
  return /^\s*(?:\d+(?:\.\d+)*|[ivxlcdm]+(?:\.\d+)*)(?:[.)]?\s+)\p{L}/iu.test(text);
}
export function sourceSpans(items: SourceText[]): SourceSpan[] {
  let offset = 0;
  return items.map((item) => {
    const start = offset;
    offset += normalizedSourceText(item.text).length;
    return {
      sourceId: item.id,
      start,
      end: offset,
      rect: { x: item.x, y: item.y, width: item.width, height: item.height },
    };
  });
}
function median(values: number[]): number {
  const sorted = values.filter((v) => v > 0).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 12;
}
function rows(items: SourceText[]): Row[] {
  const grouped: SourceText[][] = [];
  for (const item of [...items].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const row = grouped.find((entries) => {
      const box = union(entries);
      const overlap = Math.min(box.y + box.height, item.y + item.height) - Math.max(box.y, item.y);
      return (
        overlap > Math.min(box.height, item.height) * 0.3 ||
        Math.abs(box.y + box.height / 2 - item.y - item.height / 2) <
          Math.max(box.height, item.height) * 0.55
      );
    });
    if (row) row.push(item);
    else grouped.push([item]);
  }
  return grouped
    .map((entries) => {
      const ordered = entries.sort((a, b) => a.x - b.x);
      let text = '';
      let previous: SourceText | undefined;
      for (const item of ordered) {
        if (
          previous &&
          (item.spaceBefore ||
            item.x - previous.x - previous.width >
              Math.min(item.fontSize, previous.fontSize) * 0.15) &&
          !/\s$/u.test(text) &&
          !/^\s/u.test(item.text)
        )
          text += ' ';
        text += item.text;
        previous = item;
      }
      return {
        items: ordered,
        text,
        ...union(ordered),
        size: median(ordered.map((item) => item.fontSize)),
      };
    })
    .sort((a, b) => a.y - b.y || a.x - b.x);
}

/** Table evidence uses baselines, since tight leading can make adjacent glyph boxes overlap. */
function tableRows(items: SourceText[]): Row[] {
  const baseline = (item: SourceText) => item.baselineY ?? item.y + item.fontSize;
  const grouped: SourceText[][] = [];
  for (const item of [...items].sort((a, b) => baseline(a) - baseline(b) || a.x - b.x)) {
    const last = grouped.at(-1),
      anchor = last?.[0];
    if (
      anchor &&
      Math.abs(baseline(anchor) - baseline(item)) <=
        // Superscript units belong to the full-size heading row rather than
        // becoming a tiny first row that makes ordinary table cells look like prose.
        Math.max(
          1,
          Math.max(anchor.fontSize, item.fontSize) *
            (Math.min(anchor.fontSize, item.fontSize) <
            Math.max(anchor.fontSize, item.fontSize) * 0.8
              ? 0.6
              : 0.4),
        )
    )
      last!.push(item);
    else grouped.push([item]);
  }
  return grouped.map((entries) => ({
    items: entries.sort((a, b) => a.x - b.x),
    text: entries.map((item) => item.text).join(' '),
    ...union(entries),
    size: median(entries.map((item) => item.fontSize)),
  }));
}

function tableSegments(row: Row): { x: number; right: number }[] {
  const groups: { x: number; right: number }[] = [];
  for (const item of row.items) {
    const previous = groups.at(-1);
    if (previous && item.x - previous.right <= Math.max(3, row.size * 0.8))
      previous.right = Math.max(previous.right, item.x + item.width);
    else groups.push({ x: item.x, right: item.x + item.width });
  }
  return groups;
}

/** A small three-column table can have long wrapped cells and only disconnected edge ink. */
function wrappedTableEntry(
  page: SourcePage,
  available: SourceText[],
  caption: SourceText,
  textSize: number,
): TaggedEntry | undefined {
  const compact = available.filter(
    (item) =>
      item.y > caption.y + caption.fontSize &&
      item.y < caption.y + textSize * 50 &&
      item.x >= caption.x - textSize * 2 &&
      item.fontSize < caption.fontSize * 0.98,
  );
  const lines = tableRows(compact);
  const first = lines.find(
    (row) =>
      row.y < caption.y + textSize * 8 &&
      Math.abs(row.x - caption.x) < textSize * 2 &&
      tableSegments(row).length === 3,
  );
  if (!first) return;
  const starts = tableSegments(first).map((segment) => segment.x);
  const guides = page.graphicRegions.filter(
    (region) =>
      region.x >= first.x - textSize * 2 &&
      region.x + region.width <= first.x + first.width + textSize * 4 &&
      region.width >= textSize &&
      region.height <= textSize * 3,
  );
  const header = guides.filter(
    (region) => region.y >= first.y - textSize && region.y <= first.y + first.height,
  );
  if (!header.length) return;
  const endings: Rect[][] = [];
  for (const region of guides.filter(
    (edge) =>
      edge.y > first.y + first.size * 5 &&
      edge.height <= textSize &&
      edge.y < caption.y + textSize * 50,
  )) {
    const same = endings.find((parts) => Math.abs(parts[0].y - region.y) < textSize);
    if (same) same.push(region);
    else endings.push([region]);
  }
  for (const closing of endings.map(union).sort((a, b) => a.y - b.y)) {
    if (
      closing.width < first.width * 0.9 ||
      closing.x > first.x + textSize ||
      closing.x + closing.width < first.x + first.width
    )
      continue;
    const entries = compact.filter(
      (item) =>
        item.y >= first.y - first.size * 0.5 &&
        item.y + item.height / 2 < closing.y + closing.height &&
        item.x >= closing.x - 1 &&
        item.x + item.width <= closing.x + closing.width + 1,
    );
    const matrix = tableRows(entries);
    if (
      matrix.length < 6 ||
      starts.some(
        (x) =>
          matrix.filter((row) =>
            tableSegments(row).some((segment) => Math.abs(segment.x - x) <= first.size * 1.2),
          ).length < 4,
      )
    )
      continue;
    // A prose line crossing a cell boundary invalidates the proposed table envelope.
    if (
      entries.some((item) =>
        starts
          .slice(1)
          .some((x) => item.x < x - first.size * 0.5 && item.x + item.width > x + first.size * 0.5),
      )
    )
      continue;
    const box = union(entries);
    if (closing.y - box.y - box.height > textSize * 2) continue;
    return { id: `ruled:${caption.id}`, items: entries, bounds: union([box, ...header, closing]) };
  }
}

/** Text masking sometimes leaves only tiny header-rule fragments above a dense matrix. */
function fragmentedTableEntry(
  page: SourcePage,
  available: SourceText[],
  caption: SourceText,
  textSize: number,
): TaggedEntry | undefined {
  const compact = tableRows(
    available.filter(
      (item) =>
        item.y > caption.y + caption.fontSize &&
        item.y < caption.y + textSize * 25 &&
        item.fontSize < caption.fontSize * 0.98,
    ),
  );
  const first = compact.find(
    (row) =>
      row.y < caption.y + textSize * 8 &&
      Math.abs(row.x - caption.x) < textSize * 2 &&
      tableSegments(row).length >= 4,
  );
  if (!first) return;
  const matrix: Row[] = [];
  for (const row of compact.slice(compact.indexOf(first))) {
    const previous = matrix.at(-1);
    if (
      tableSegments(row).length < 4 ||
      Math.abs(row.size - first.size) > first.size * 0.15 ||
      (previous && row.y - previous.y > first.size * 2.5)
    )
      break;
    matrix.push(row);
  }
  if (matrix.length < 5) return;
  const starts = tableSegments(first).map((segment) => segment.x);
  if (
    starts.filter(
      (x) =>
        matrix.filter((row) =>
          tableSegments(row).some((segment) => Math.abs(segment.x - x) <= first.size),
        ).length >= 5,
    ).length < 4
  )
    return;
  const entries = matrix.flatMap((row) => row.items),
    cells = union(entries),
    guides = page.graphicRegions.filter(
      (region) =>
        region.height <= textSize &&
        region.width >= first.size * 2 &&
        region.x >= cells.x - textSize * 2 &&
        region.x + region.width <= cells.x + cells.width + textSize * 2,
    ),
    header = guides.filter(
      (region) => region.y >= first.y - textSize && region.y <= first.y + first.height,
    ),
    last = matrix.at(-1)!,
    footer = guides.filter(
      (region) =>
        region.y >= last.y + last.height - textSize && region.y <= last.y + last.height + textSize,
    );
  if (!header.length || !footer.length) return;
  const closing = union(footer);
  if (
    closing.width < cells.width * 0.65 ||
    Math.abs(closing.x + closing.width / 2 - cells.x - cells.width / 2) > textSize * 2
  )
    return;
  return {
    id: `ruled:${caption.id}`,
    items: entries,
    bounds: union([
      {
        ...cells,
        x: cells.x - first.size,
        y: first.y - first.size,
        width: cells.width + first.size * 2,
        height: cells.height + first.size,
      },
      ...header,
      closing,
    ]),
  };
}

/** A caption, ruled edges and repeated cell columns are all required for untagged tables. */
function ruledTableEntries(
  page: SourcePage,
  claimed: Set<string>,
  bodySize: number,
): TaggedEntry[] {
  const candidates: TaggedEntry[] = [];
  const available = page.items.filter((item) => !claimed.has(item.id));
  const baseline = (item: SourceText) => item.baselineY ?? item.y + item.fontSize;
  const captionStart =
    /^(?:table|표)\s*(?:\d+(?:\.\d+)*[a-z]?|[a-z](?:\.\d+)+|[IVXLC]+)(?:[.:](?:\s|$)|\s*$)/iu;
  const isCaption = (caption: SourceText) => {
    if (!captionStart.test(caption.text.trim()) || caption.structureRoles?.includes('Link'))
      return false;
    // A punctuated table label can share a PDF baseline with its title or "Cont.".
    // An unpunctuated inline reference followed by ordinary prose is ambiguous.
    return (
      /^(?:table|표)\s*(?:\d+(?:\.\d+)*[a-z]?|[a-z](?:\.\d+)+|[IVXLC]+)[.:](?:\s|$)/iu.test(
        caption.text.trim(),
      ) ||
      /^(?:table|표)\s*(?:\d+|[a-z])\.\d+(?:\.\d+)*[a-z]?$/iu.test(caption.text.trim()) ||
      !available.some(
        (item) =>
          item !== caption &&
          Math.abs(baseline(item) - baseline(caption)) < caption.fontSize * 0.3 &&
          item.x >= caption.x + caption.width - caption.fontSize * 0.1 &&
          item.x - caption.x - caption.width < caption.fontSize * 2,
      )
    );
  };
  for (const caption of available) {
    const textSize = Math.max(bodySize, caption.fontSize);
    if (!isCaption(caption)) continue;
    const nearParts = page.graphicRegions.filter(
      (region) =>
        region.y >= caption.y - textSize * 2 &&
        region.y + region.height > baseline(caption) + textSize * 0.4 &&
        region.y < caption.y + caption.fontSize * 12 &&
        region.height <= textSize * 6 &&
        region.width >= textSize * 2,
    );
    const nearRows: Rect[][] = [];
    for (const region of nearParts) {
      const same = nearRows.find((row) => {
        const box = union(row);
        return (
          Math.abs(box.y - region.y) <= textSize * 0.8 ||
          Math.min(box.y + box.height, region.y + region.height) > Math.max(box.y, region.y)
        );
      });
      if (same) same.push(region);
      else nearRows.push([region]);
    }
    const nearRules = nearRows
      .map(union)
      .filter(
        (region) =>
          region.width >= Math.max(60, textSize * 8) &&
          caption.x >= region.x - textSize * 4 &&
          caption.x <= region.x + region.width + textSize * 2,
      )
      .sort((a, b) => a.y - b.y || b.width - a.width);
    let anchor = nearRules[0];
    if (!anchor) {
      const fragmented =
        fragmentedTableEntry(page, available, caption, textSize) ??
        wrappedTableEntry(page, available, caption, textSize);
      if (fragmented) candidates.push(fragmented);
      continue;
    }
    // A multi-line heading can mask most of its top rule. Its surviving edge
    // fragments still extend a lower, more complete separator to the full width.
    const initialAnchor = anchor;
    anchor = union([
      anchor,
      ...nearParts.filter((region) => {
        if (region.y >= initialAnchor.y) return false;
        const combined = union([region, initialAnchor]);
        const overlap =
          Math.min(region.x + region.width, initialAnchor.x + initialAnchor.width) -
          Math.max(region.x, initialAnchor.x);
        return (
          (overlap > Math.min(region.width, initialAnchor.width) * 0.25 &&
            combined.width <= initialAnchor.width * 1.3) ||
          (overlap >= -textSize * 4 &&
            combined.width <= initialAnchor.width * 2.5 &&
            page.graphicRegions.some(
              (edge) =>
                edge.y > initialAnchor.y + initialAnchor.height &&
                edge.y < caption.y + textSize * 50 &&
                edge.height < textSize &&
                edge.width >= combined.width * 0.65 &&
                Math.abs(edge.x - combined.x) < textSize * 2 &&
                Math.abs(edge.x + edge.width - combined.x - combined.width) < textSize * 2,
            ))
        );
      }),
    ]);
    if (caption.x < anchor.x && anchor.x - caption.x < textSize * 4)
      anchor = { ...anchor, x: caption.x, width: anchor.x + anchor.width - caption.x };
    // Centered tables often cross the page midpoint without spanning its full width.
    // Their own rules define the column envelope more reliably than the page gutter.
    const left = anchor.x - textSize,
      right = anchor.x + anchor.width + textSize;
    const inColumn = (rect: Rect) => rect.x >= left && rect.x + rect.width <= right + 1;
    const columnRows = tableRows(
      available.filter((item) => inColumn(item) && item.y > caption.y + caption.fontSize * 0.5),
    );
    const segments = tableSegments;
    const divided = (row: Row) => segments(row).length >= 2;
    const first = columnRows.find(
      (row) =>
        row.y < caption.y + caption.fontSize * 12 &&
        row.y + row.height / 2 >= anchor.y &&
        row.size <= textSize * 1.15 &&
        (divided(row) || row.width <= anchor.width) &&
        nearRules.some((region) => Math.abs(region.y - row.y) < textSize * 3),
    );
    if (!first) continue;
    const after = columnRows.filter((row) => row.y >= first.y - first.size * 0.8);
    const stop = after.find(
      (row) =>
        row.y > first.y + first.size && row.size > first.size * 1.18 && /\p{L}{3}/u.test(row.text),
    );
    const nextCaption = Math.min(
      ...available
        .filter((item) => item.y > first.y && inColumn(item) && isCaption(item))
        .map((item) => item.y),
    );
    const end = Math.min(stop?.y ?? page.height, nextCaption, page.height);
    const ruleParts = page.graphicRegions.filter(
      (region) =>
        region.height <= textSize * 6 &&
        region.width >= textSize &&
        region.x >= anchor.x - textSize * 2 &&
        region.x + region.width <= anchor.x + anchor.width + textSize * 2 &&
        region.y >= Math.min(anchor.y, first.y - textSize * 3) &&
        region.y + region.height < end,
    );
    // Masked cell text can break one horizontal rule into disconnected fragments.
    const ruleRows: Rect[][] = [];
    for (const region of ruleParts) {
      const same = ruleRows.find((row) => {
        const box = union(row);
        return (
          Math.abs(box.y - region.y) <= textSize * 0.8 ||
          Math.min(box.y + box.height, region.y + region.height) > Math.max(box.y, region.y)
        );
      });
      if (same) same.push(region);
      else ruleRows.push([region]);
    }
    const rules = ruleRows
      .map(union)
      .filter(
        (region) =>
          region.width >= anchor.width * 0.65 &&
          (Math.abs(region.x - anchor.x) <= textSize * 2 ||
            Math.abs(region.x + region.width / 2 - anchor.x - anchor.width / 2) <= textSize * 2),
      );
    if (
      rules.length < 2 ||
      Math.max(...rules.map((region) => region.y)) - Math.min(...rules.map((region) => region.y)) <
        textSize * 2
    )
      continue;
    let bottom = Math.max(...rules.map((region) => region.y + region.height));
    // Continued tables may have only top/header rules; a dense aligned run
    // below them remains a table when no closing rule survives text masking.
    const openRows: Row[] = [];
    for (const row of after) {
      if (!divided(row) || Math.abs(row.size - first.size) > first.size * 0.15) {
        if (openRows.length) break;
        continue;
      }
      if (
        openRows.length &&
        row.y - openRows.at(-1)!.y > first.size * (openRows.length === 1 ? 3.5 : 2.5)
      )
        break;
      if (row.y >= end) break;
      openRows.push(row);
    }
    if (openRows.length >= 5 && bottom < openRows.at(-1)!.y) {
      const columns = tableSegments(openRows[0]).filter(
        (segment) =>
          openRows.filter((row) =>
            tableSegments(row).some((other) => Math.abs(other.x - segment.x) <= first.size),
          ).length >= 5,
      );
      if (columns.length >= 2) bottom = openRows.at(-1)!.y + openRows.at(-1)!.height;
    }
    const cellRows = columnRows.filter(
      (row) =>
        row.y >= Math.min(anchor.y, first.y - first.size * 0.8) && row.y < bottom && row.y < end,
    );
    const matrix = cellRows.filter(divided);
    if (matrix.length < 3) {
      const singleColumn =
        matrix.length === 0 &&
        cellRows.length >= 5 &&
        cellRows.every((row) => Math.abs(row.x - first.x) <= first.size * 2);
      if (!singleColumn && !(matrix.length >= 2 && rules.length >= 3)) continue;
    }
    const starts: { x: number; rows: Set<Row> }[] = [];
    for (const row of matrix)
      for (const segment of segments(row)) {
        const existing = starts.find((entry) => Math.abs(entry.x - segment.x) <= first.size * 0.8);
        if (existing) existing.rows.add(row);
        else starts.push({ x: segment.x, rows: new Set([row]) });
      }
    const stable = starts
      .filter((entry) => entry.rows.size >= Math.min(3, matrix.length))
      .map((entry) => entry.x);
    if (matrix.length && !stable.some((x) => stable.some((other) => other - x > first.size * 2.5)))
      continue;
    candidates.push({
      id: `ruled:${caption.id}`,
      items: cellRows.flatMap((row) => row.items),
      bounds: union([anchor, ...rules]),
    });
  }
  return candidates;
}

/** Uncaptioned appendix matrices still need multiple rules and three recurring cell columns. */
function uncaptionedTableEntries(
  page: SourcePage,
  claimed: Set<string>,
  size: number,
): TaggedEntry[] {
  const found: TaggedEntry[] = [];
  const guides = page.graphicRegions
    .filter(
      (r) =>
        r.width >= size * 20 &&
        r.height <= size * 4 &&
        (r.height <= size || r.width >= r.height * 12),
    )
    .map((r) =>
      r.height <= size
        ? r
        : {
            ...r,
            y: r.y + r.height - size * 0.6,
            height: size * 0.6,
          },
    );
  for (const top of guides) {
    const separator = guides.find(
      (r) =>
        r.y > top.y + size &&
        r.y < top.y + size * 6 &&
        Math.abs(r.x - top.x) < size &&
        Math.abs(r.width - top.width) < size * 2,
    );
    if (!separator) continue;
    const inWidth = page.items.filter(
      (item) =>
        !claimed.has(item.id) &&
        !found.some((entry) => entry.items.includes(item)) &&
        item.x >= top.x - 1 &&
        item.x + item.width <= top.x + top.width + 1 &&
        item.y >= top.y &&
        item.fontSize <= size * 1.15,
    );
    const lines = tableRows(inWidth);
    const headers = lines.filter((r) => r.y < separator.y);
    if (!headers.some((r) => tableSegments(r).length >= 3)) continue;
    const run: Row[] = [];
    for (const row of lines.filter((r) => r.y >= separator.y)) {
      const segments = tableSegments(row);
      const starts = run.length ? tableSegments(run[0]).map((segment) => segment.x) : [];
      const continuation =
        run.length >= 8 &&
        Math.abs(row.size - run[0].size) < size * 0.15 &&
        segments.every((segment) =>
          starts.some(
            (x, index) =>
              segment.x >= x - size &&
              segment.x < x + size * 4 &&
              segment.right <= (starts[index + 1] ?? top.x + top.width) + 1,
          ),
        );
      if (
        (segments.length < 3 && !continuation) ||
        (run.length && row.y - run.at(-1)!.y > size * 2.5)
      )
        break;
      run.push(row);
    }
    if (run.length < 8) continue;
    const stable = tableSegments(run[0]).filter(
      (segment) =>
        run.filter((row) =>
          tableSegments(row).some((other) => Math.abs(other.x - segment.x) < size),
        ).length >= 8,
    );
    if (stable.length < 3) continue;
    const entries = [...headers, ...run].flatMap((r) => r.items);
    const box = union(entries);
    found.push({
      id: `matrix:${entries[0].id}`,
      items: entries,
      bounds: union([
        top,
        separator,
        box,
        ...guides.filter(
          (r) =>
            r.y >= box.y + box.height &&
            r.y < box.y + box.height + size &&
            Math.abs(r.x - top.x) < size &&
            Math.abs(r.width - top.width) < size * 2,
        ),
      ]),
    });
  }
  return found;
}

/** Split an explicitly labelled index/contents page before pairing entries and page numbers. */
function entryColumns(items: SourceText[], width: number): SourceText[][] {
  const split = (
    entries: SourceText[],
    left: number,
    right: number,
    depth: number,
  ): SourceText[][] => {
    if (depth >= 2) return [entries];
    const local = entries.map((item) => ({ ...item, x: item.x - left }));
    const size = median(entries.map((item) => item.fontSize));
    const last = Math.max(...entries.map((item) => item.y));
    const spacedHeading = (item: SourceText) => /(?:\p{L}\s+){5}/u.test(item.text);
    const body = local.filter((item) => item.y < last - size * 4 && !spacedHeading(item));
    const intervals: { left: number; right: number }[] = [];
    for (const item of [...body].sort((a, b) => a.x - b.x)) {
      const previous = intervals.at(-1);
      if (previous && item.x <= previous.right)
        previous.right = Math.max(previous.right, item.x + item.width);
      else intervals.push({ left: item.x, right: item.x + item.width });
    }
    const clear = intervals
      .slice(1)
      .map((interval, i) => ({
        x: (interval.left + intervals[i].right) / 2,
        width: interval.left - intervals[i].right,
      }))
      .filter(
        (gap) =>
          gap.width >= size * 0.8 &&
          gap.x >= (right - left) * 0.2 &&
          gap.x <= (right - left) * 0.8 &&
          [body.filter((item) => item.x < gap.x), body.filter((item) => item.x >= gap.x)].every(
            (side) => side.filter((item) => /\p{L}{3}/u.test(item.text)).length >= 4,
          ),
      )
      .sort((a, b) => b.width - a.width)[0];
    const gutter = clear?.x ?? findColumnGutter(local, right - left);
    if (gutter === undefined) return [entries];
    const x = gutter + left;
    // A heading spanning the gutter belongs to the page, not either entry column.
    const crossing = entries.filter((item) => item.x < x && item.x + item.width > x);
    const firstPaired = Math.min(
      ...rows(entries.filter((item) => !crossing.includes(item)))
        .filter((row) =>
          [row.items.filter((item) => item.x < x), row.items.filter((item) => item.x >= x)].every(
            (side) => side.some((item) => /\p{L}{3}/u.test(item.text)),
          ),
        )
        .map((row) => row.y),
    );
    if (
      crossing.some(
        (item) =>
          !spacedHeading(item) &&
          (!Number.isFinite(firstPaired) || item.y + item.height > firstPaired - size * 0.25) &&
          item.y < Math.max(...entries.map((entry) => entry.y)) - item.fontSize * 4,
      )
    )
      return [entries];
    const before = entries.filter((item) => item.x + item.width <= x);
    const after = entries.filter((item) => item.x >= x);
    if (before.length < 3 || after.length < 3) return [entries];
    return [
      ...split(before, left, x, depth + 1),
      ...split(after, x, right, depth + 1),
      ...(crossing.length ? [crossing] : []),
    ];
  };
  return split(items, 0, width, 0);
}

function label(text: string): string | undefined {
  const match =
    /^(?:\[\s*(\d{1,3})\s*\]|[（(]\s*(\d{1,3})\s*[)）]|(\d{1,3})(?:[.)]|(?=\s|$))|([*†‡]))/u.exec(
      text.normalize('NFKC').trim(),
    );
  return match?.slice(1).find(Boolean);
}
function markerLabel(text: string): string | undefined {
  const value = text.normalize('NFKC').replace(/\s/gu, '');
  return /^(?:\d{1,3}|\[\d{1,3}\]|[（(]\d{1,3}[)）]|\d{1,3}[.)]|[*†‡])$/u.test(value)
    ? label(value)
    : undefined;
}
function makeBlock(
  page: SourcePage,
  entries: SourceText[],
  semantic: NonNullable<ReadingBlock['semantic']>,
  preserve: boolean,
  key: string,
): ReadingBlock {
  if (
    semantic === 'note' &&
    !preserve &&
    entries.some(
      (item, index) =>
        index > 0 &&
        item.y < entries[index - 1].y - Math.max(item.fontSize, entries[index - 1].fontSize),
    )
  )
    preserve = true;
  const lines = rows(entries),
    ordered = lines.flatMap((row) => row.items),
    text = lines.map((row) => row.text.trim()).join(' ');
  if (
    semantic === 'note' &&
    lines.some((row) =>
      row.items.some(
        (item, index) =>
          index > 0 &&
          item.x - row.items[index - 1].x - row.items[index - 1].width >
            Math.max(36, item.fontSize * 3),
      ),
    )
  )
    preserve = true;
  return {
    id: `p${page.number}:semantic:${key}`,
    kind: preserve ? 'sourceRegion' : 'footnote',
    semantic,
    sourcePage: page.number,
    sourceIds: ordered.map((item) => item.id),
    rect: union(ordered),
    rawText: lines.map((row) => row.items.map((item) => item.text).join('')).join('\n'),
    text,
    fontSize: median(ordered.map((item) => item.fontSize)),
    sourceSpans: sourceSpans(ordered),
    keepTogether: true,
    confidence: preserve ? 'review' : 'high',
    ...(semantic === 'note'
      ? { noteLabel: label(text) ?? markerLabel(ordered[0]?.text ?? '') }
      : {}),
    ...(preserve
      ? {
          reason:
            semantic === 'note'
              ? '복합 각주·미주 항목을 함께 보존'
              : `${semantic === 'toc' ? '목차' : '색인'} 항목과 참조 쪽번호를 함께 보존`,
        }
      : {}),
  };
}
function descendantOf(
  group: SourceStructure,
  parent: SourceStructure,
  groups: Map<string, SourceStructure>,
): boolean {
  let current: SourceStructure | undefined = group;
  const visited = new Set<string>();
  while (current?.parentId && !visited.has(current.id)) {
    visited.add(current.id);
    if (current.parentId === parent.id) return true;
    current = groups.get(current.parentId);
  }
  return false;
}

interface TaggedEntry {
  id: string;
  items: SourceText[];
  bounds?: Rect;
}

function paragraphEntries(
  parent: SourceStructure,
  structures: SourceStructure[],
  groups: Map<string, SourceStructure>,
  items: Map<string, SourceText>,
): TaggedEntry[] {
  return structures
    .filter((group) => {
      if (group.role !== 'P' || !descendantOf(group, parent, groups)) return false;
      let ancestor = group.parentId ? groups.get(group.parentId) : undefined;
      const visited = new Set<string>();
      while (ancestor && ancestor.id !== parent.id && !visited.has(ancestor.id)) {
        visited.add(ancestor.id);
        if (ancestor.role === 'P') return false;
        ancestor = ancestor.parentId ? groups.get(ancestor.parentId) : undefined;
      }
      return true;
    })
    .sort((a, b) => a.order - b.order)
    .map((group) => ({
      id: group.id,
      items: group.sourceIds.flatMap((id) =>
        items.get(id) && !items.get(id)!.artifact ? [items.get(id)!] : [],
      ),
    }))
    .filter((entry) => entry.items.length > 0);
}

/** TOC writers may put the title, hanging continuation and right page number in separate P tags. */
function tocParagraphEntries(entries: TaggedEntry[], pageWidth: number): TaggedEntry[] {
  const grouped: TaggedEntry[] = [];
  const hasPage = (items: SourceText[]) =>
    rows(items).some(
      (row) =>
        hasTocLeader(row.text) ||
        row.items.some((item) => item.x > pageWidth * 0.6 && pageNumber.test(item.text.trim())),
    );
  for (const entry of entries) {
    const box = union(entry.items);
    const size = median(entry.items.map((item) => item.fontSize));
    const previous = grouped.at(-1);
    const overlap = grouped.find((candidate) => {
      const rect = union(candidate.items);
      return (
        Math.min(rect.y + rect.height, box.y + box.height) - Math.max(rect.y, box.y) >
        Math.min(rect.height, box.height) * 0.25
      );
    });
    let target = overlap;
    if (!target && previous && !hasPage(previous.items)) {
      const rect = union(previous.items);
      const gap = box.y - rect.y - rect.height;
      const newLabel = startsTocEntry(rows(entry.items)[0].text);
      if (
        !newLabel &&
        gap >= -1 &&
        gap <= size * 1.5 &&
        box.x >= rect.x - size &&
        (box.x <= rect.x + size * 3 || hasPage(entry.items))
      )
        target = previous;
    }
    if (target) target.items.push(...entry.items);
    else grouped.push({ id: entry.id, items: [...entry.items] });
  }
  return grouped;
}

/** Compound entries are claimed before numeric columns influence prose grouping. */
function entryWithPrecedingLines(
  last: Row,
  candidates: Row[],
  endings: Set<Row>,
  claimed: Set<string>,
  after: number,
): SourceText[] {
  const lines = [last];
  let current = last;
  for (let index = candidates.indexOf(last) - 1; index >= 0; index--) {
    const previous = candidates[index];
    const gap = current.y - previous.y - previous.height;
    const size = Math.max(current.size, previous.size);
    if (
      previous.y <= after ||
      endings.has(previous) ||
      previous.items.some((item) => claimed.has(item.id)) ||
      (!/\p{L}/u.test(previous.text) && !pageNumber.test(previous.text.trim())) ||
      gap < -1 ||
      gap > size * 1.5 ||
      Math.abs(previous.size - current.size) > size * 0.2 ||
      previous.x > current.x + size ||
      previous.x < current.x - size * 3
    )
      break;
    lines.unshift(previous);
    current = previous;
  }
  return lines.flatMap((line) => line.items);
}

export function analyzePageSemantics(page: SourcePage): PageSemantics {
  if (
    !Number.isFinite(page.width) ||
    !Number.isFinite(page.height) ||
    page.width <= 0 ||
    page.height <= 0 ||
    page.rotation % 360 !== 0 ||
    page.items.some(
      (item) =>
        ![item.x, item.y, item.width, item.height, item.fontSize].every(Number.isFinite) ||
        item.width < 0 ||
        item.height <= 0,
    )
  )
    return { blocks: [], lineNumbers: [], referenceIds: new Set() };
  const blocks: ReadingBlock[] = [],
    claimed = new Set<string>(),
    items = new Map(page.items.map((item) => [item.id, item]));
  const structures = page.structure ?? [],
    groupMap = new Map(structures.map((group) => [group.id, group]));
  const allRows = rows(page.items),
    bodySize = median(
      page.items.filter((item) => item.text.trim().length > 8).map((item) => item.fontSize),
    );
  const add = (
    entries: SourceText[],
    semantic: NonNullable<ReadingBlock['semantic']>,
    preserve: boolean,
    key: string,
  ) => {
    let free = entries.filter((item) => !claimed.has(item.id));
    if (!free.length) return;
    let rect = union(free);
    preserve ||= page.graphicRegions.some((region) => intersects(region, rect, 0));
    preserve ||=
      semantic === 'note' &&
      (free.some(
        (item, index) =>
          index > 0 &&
          item.y < free[index - 1].y - Math.max(item.fontSize, free[index - 1].fontSize),
      ) ||
        rows(free).some((row) =>
          row.items.some(
            (item, index) =>
              index > 0 &&
              item.x - row.items[index - 1].x - row.items[index - 1].width >
                Math.max(36, item.fontSize * 3),
          ),
        ));
    if (preserve) {
      for (let pass = 0; pass < page.items.length + 1; pass++) {
        const entry = semantic === 'toc' || semantic === 'index';
        const centered = (box: Rect) =>
          box.x + box.width / 2 >= rect.x &&
          box.x + box.width / 2 <= rect.x + rect.width &&
          box.y + box.height / 2 >= rect.y &&
          box.y + box.height / 2 <= rect.y + rect.height;
        const overlapping = blocks.filter((block) =>
          entry ? centered(block.rect) : intersects(rect, block.rect, 0.2),
        );
        for (const block of overlapping) {
          blocks.splice(blocks.indexOf(block), 1);
          for (const id of block.sourceIds) claimed.delete(id);
          rect = union([rect, block.rect]);
        }
        const included = page.items.filter(
          (item) => !claimed.has(item.id) && (entry ? centered(item) : intersects(rect, item, 0.2)),
        );
        const graphics = page.graphicRegions.filter((region) => intersects(rect, region, 0));
        const expanded = clampRect(
          union([rect, ...included, ...graphics]),
          page.width,
          page.height,
        );
        free = [...new Map([...free, ...included].map((item) => [item.id, item])).values()];
        if (
          expanded.x === rect.x &&
          expanded.y === rect.y &&
          expanded.width === rect.width &&
          expanded.height === rect.height
        )
          break;
        rect = expanded;
      }
    }
    const block = makeBlock(page, free, semantic, preserve, key);
    if (preserve) block.rect = rect;
    if (preserve && (semantic === 'toc' || semantic === 'index')) {
      const last = tableRows(free).at(-1)!;
      const own = new Set(free.map((item) => item.id));
      const nextTop = Math.min(
        ...page.items
          .filter(
            (item) =>
              !own.has(item.id) &&
              item.y > last.y + last.size * 0.6 &&
              item.fontSize >= last.size * 0.75 &&
              item.x < rect.x + rect.width &&
              item.x + item.width > rect.x,
          )
          .map((item) => item.y),
      );
      // Some PDF fonts expose boxes taller than their baseline spacing. Keep
      // owned descenders, while excluding the next entry's unrelated ink.
      const descenders = Math.max(
        ...free.map((item) => (item.baselineY ?? item.y + item.fontSize) + item.fontSize * 0.2),
      );
      const bottom = Math.max(nextTop, descenders);
      if (bottom < rect.y + rect.height) block.rect = { ...rect, height: bottom - rect.y };
    }
    blocks.push(block);
    free.forEach((item) => claimed.add(item.id));
  };
  const addTable = (entries: SourceText[], key: string, tagged = true, bounds?: Rect) => {
    const free = [...new Map(entries.map((item) => [item.id, item])).values()].filter(
      (item) => !claimed.has(item.id),
    );
    // A partially claimed or overlapping structure cannot safely introduce another crop.
    if (!free.length || free.length !== new Set(entries.map((item) => item.id)).size) return;
    const cellRect = union(free),
      padding = Math.max(3, median(free.map((item) => item.fontSize)) * 2);
    const graphics = page.graphicRegions.filter((region) =>
      bounds
        ? region.x >= bounds.x - 1 &&
          region.y >= bounds.y - 1 &&
          region.x + region.width <= bounds.x + bounds.width + 1 &&
          region.y + region.height <= bounds.y + bounds.height + 1
        : region.x >= cellRect.x - padding &&
          region.y >= cellRect.y - padding &&
          region.x + region.width <= cellRect.x + cellRect.width + padding &&
          region.y + region.height <= cellRect.y + cellRect.height + padding &&
          intersects(region, cellRect, padding),
    );
    const inside = (item: SourceText) =>
      item.x + item.width / 2 >= cellRect.x &&
      item.x + item.width / 2 <= cellRect.x + cellRect.width &&
      item.y + item.height / 2 >= cellRect.y &&
      item.y + item.height / 2 <= cellRect.y + cellRect.height;
    if (page.items.some((item) => claimed.has(item.id) && inside(item))) return;
    const included = page.items.filter((item) => inside(item));
    const ordered = rows([
      ...new Map([...free, ...included].map((item) => [item.id, item])).values(),
    ]);
    const owned = ordered.flatMap((row) => row.items);
    const ownedIds = new Set(owned.map((item) => item.id));
    const contentRect = union(owned),
      edge = Math.min(3, padding / 3),
      sidePadding = bounds ? Math.min(3, padding) : padding;
    const padded = {
      x: contentRect.x - sidePadding,
      y: contentRect.y - edge,
      width: contentRect.width + sidePadding * 2,
      height: contentRect.height + edge * 2,
    };
    const envelope = union([padded, ...graphics, ...(bounds ? [bounds] : [])]);
    let left = envelope.x,
      top = envelope.y,
      right = envelope.x + envelope.width,
      bottom = envelope.y + envelope.height;
    for (const item of page.items.filter((entry) => !ownedIds.has(entry.id))) {
      if (!intersects(envelope, item)) continue;
      const centerX = item.x + item.width / 2,
        centerY = item.y + item.height / 2;
      if (item.x < right && item.x + item.width > left) {
        if (centerY < contentRect.y && item.y + item.height - top > item.fontSize * 0.35)
          top = Math.max(top, Math.min(contentRect.y, item.y + item.height));
        if (centerY > contentRect.y + contentRect.height && bottom - item.y > item.fontSize * 0.35)
          bottom = Math.min(bottom, Math.max(contentRect.y + contentRect.height, item.y));
      }
      if (item.y < bottom && item.y + item.height > top) {
        if (centerX < contentRect.x)
          left = Math.max(left, Math.min(contentRect.x, item.x + item.width));
        if (centerX > contentRect.x + contentRect.width)
          right = Math.min(right, Math.max(contentRect.x + contentRect.width, item.x));
      }
    }
    for (const region of page.graphicRegions.filter((entry) => !graphics.includes(entry))) {
      if (!intersects(envelope, region) || intersects(contentRect, region)) continue;
      if (region.x >= contentRect.x + contentRect.width) right = Math.min(right, region.x);
      if (region.x + region.width <= contentRect.x) left = Math.max(left, region.x + region.width);
      if (region.y >= contentRect.y + contentRect.height) bottom = Math.min(bottom, region.y);
      if (region.y + region.height <= contentRect.y) top = Math.max(top, region.y + region.height);
    }
    const rect = clampRect(
      { x: left, y: top, width: right - left, height: bottom - top },
      page.width,
      page.height,
    );
    blocks.push({
      id: `p${page.number}:table:${key}`,
      kind: 'sourceRegion',
      semantic: 'table',
      sourcePage: page.number,
      sourceIds: owned.map((item) => item.id),
      sourceSpans: sourceSpans(owned),
      rect,
      rawText: ordered.map((row) => row.items.map((item) => item.text).join('')).join('\n'),
      text: ordered.map((row) => row.text.trim()).join(' '),
      fontSize: median(owned.map((item) => item.fontSize)),
      keepTogether: true,
      reason: tagged
        ? '태그로 지정된 표를 원문 모양으로 보존'
        : '표 제목·구분선·열 정렬을 함께 확인한 표를 원문 모양으로 보존',
      confidence: 'review',
    });
    owned.forEach((item) => claimed.add(item.id));
  };
  for (const group of [...structures].sort((a, b) => a.order - b.order)) {
    if (
      !noteRoles.has(group.role) &&
      !['Table', 'TOCI', 'LI', 'P', 'Index', 'TOC'].includes(group.role)
    )
      continue;
    const entries = group.sourceIds.flatMap((id) =>
      items.get(id) && !items.get(id)!.artifact ? [items.get(id)!] : [],
    );
    if (group.role === 'Table') {
      addTable(entries, group.id);
      continue;
    }
    if (noteRoles.has(group.role)) {
      const containsTable = structures.some(
        (entry) => entry.role === 'Table' && descendantOf(entry, group, groupMap),
      );
      add(entries, 'note', containsTable, group.id);
      const note = blocks.find((block) => block.id === `p${page.number}:semantic:${group.id}`);
      const labeled = structures
        .filter((entry) => entry.role === 'Lbl' && descendantOf(entry, group, groupMap))
        .sort((a, b) => a.order - b.order)
        .map((entry) =>
          markerLabel(entry.sourceIds.map((id) => items.get(id)?.text ?? '').join('')),
        )
        .find(Boolean);
      if (note && labeled) note.noteLabel = labeled;
      continue;
    }
    let ancestor: SourceStructure | undefined = group;
    let semantic: 'index' | 'toc' | undefined;
    const visited = new Set<string>();
    while (ancestor && !visited.has(ancestor.id)) {
      visited.add(ancestor.id);
      if (ancestor.role === 'Index') {
        semantic = 'index';
        break;
      }
      if (ancestor.role === 'TOC' || ancestor.role === 'TOCI') {
        semantic = 'toc';
        break;
      }
      ancestor = ancestor.parentId ? groupMap.get(ancestor.parentId) : undefined;
    }
    if (!semantic) continue;
    if (
      (group.role === 'TOC' || group.role === 'Index') &&
      structures.some(
        (entry) => ['TOCI', 'LI'].includes(entry.role) && descendantOf(entry, group, groupMap),
      )
    )
      continue;
    if (group.role === 'TOC' || group.role === 'Index') {
      const paragraphs = paragraphEntries(group, structures, groupMap, items);
      if (paragraphs.length) {
        const grouped =
          semantic === 'toc' ? tocParagraphEntries(paragraphs, page.width) : paragraphs;
        for (const entry of grouped) add(entry.items, semantic, true, entry.id);
        // Partial tagging must not discard visible content outside the P entries.
        for (const [index, row] of rows(entries.filter((item) => !claimed.has(item.id))).entries())
          add(row.items, semantic, true, `${group.id}:remaining:${index}`);
        continue;
      }
    }
    if ((group.role === 'TOC' || group.role === 'Index') && rows(entries).length > 1) {
      for (const [index, row] of rows(entries).entries())
        add(row.items, semantic, true, `${group.id}:${index}`);
    } else add(entries, semantic, true, group.id);
  }
  for (const entry of ruledTableEntries(page, claimed, bodySize))
    addTable(entry.items, entry.id, false, entry.bounds);
  for (const entry of uncaptionedTableEntries(page, claimed, bodySize))
    addTable(entry.items, entry.id, false, entry.bounds);
  for (const entry of codeBlockEntries(page, claimed)) {
    blocks.push({
      id: `p${page.number}:code:${entry.id}`,
      kind: 'sourceRegion',
      sourcePage: page.number,
      sourceIds: entry.items.map((item) => item.id),
      sourceSpans: sourceSpans(entry.items),
      rect: entry.rect,
      rawText: entry.rawText,
      text: entry.rawText,
      fontSize: median(entry.items.map((item) => item.fontSize)),
      keepTogether: true,
      reason: '코드의 줄바꿈과 들여쓰기를 원문 모양으로 보존',
      confidence: 'high',
    });
    entry.items.forEach((item) => claimed.add(item.id));
  }
  const headings = allRows.filter(
    (row) =>
      contentsHeading.test(row.text) || indexHeading.test(row.text) || notesHeading.test(row.text),
  );
  const tocHeading = headings.find((row) => contentsHeading.test(row.text)),
    idxHeading = headings.find((row) => indexHeading.test(row.text)),
    noteHeading = headings.find((row) => notesHeading.test(row.text));
  const entryItems = page.items.filter(
    (item) => !claimed.has(item.id) && !headings.some((heading) => heading.items.includes(item)),
  );
  const columns =
    tocHeading || idxHeading
      ? entryColumns(
          entryItems.filter((item) => item.y > (tocHeading?.y ?? idxHeading!.y)),
          page.width,
        )
      : [entryItems];
  const candidates = columns.flatMap(rows);
  const marginNumberIds = new Set(
    detectLineNumbers(page, claimed, bodySize).map((entry) => entry.item.id),
  );
  const referenceIds = new Set(
    structures.filter((group) => group.role === 'Reference').flatMap((group) => group.sourceIds),
  );
  const tocCandidates = candidates.filter(
    (row) =>
      tocHeading ||
      !row.items.some((item) =>
        page.graphicRegions.some(
          (region) =>
            region.height > row.size * 3 &&
            region.width > row.size * 4 &&
            item.x + item.width / 2 >= region.x &&
            item.x + item.width / 2 <= region.x + region.width &&
            item.y + item.height / 2 >= region.y &&
            item.y + item.height / 2 <= region.y + region.height,
        ),
      ),
  );
  const tocRows = tocCandidates.filter(
    (row) =>
      hasTocLeader(row.text) ||
      (row.items.length >= 2 &&
        (tocHeading ||
          (!marginNumberIds.has(row.items.at(-1)!.id) &&
            !referenceIds.has(row.items.at(-1)!.id) &&
            !row.items.at(-1)!.structureRoles?.includes('Reference'))) &&
        row.items.at(-1)!.y + row.items.at(-1)!.height / 2 >=
          row.items.at(-2)!.y + row.items.at(-2)!.height * 0.25 &&
        pageNumber.test(row.items.at(-1)!.text.trim()) &&
        (tocHeading || row.items.at(-1)!.x > page.width * 0.65) &&
        row.items.at(-1)!.x - (row.items.at(-2)!.x + row.items.at(-2)!.width) >
          bodySize * (tocHeading ? 0.3 : 2) &&
        /\p{L}{3}/u.test(
          row.items
            .slice(0, -1)
            .map((item) => item.text)
            .join(' '),
        )),
  );
  const tocEndings = new Set(tocRows);
  if (tocHeading || tocRows.length >= 3)
    for (const row of tocRows.filter((entry) => entry.y > (tocHeading?.y ?? -Infinity)))
      add(
        startsTocEntry(row.text)
          ? row.items
          : entryWithPrecedingLines(
              row,
              candidates,
              tocEndings,
              claimed,
              tocHeading?.y ?? -Infinity,
            ),
        'toc',
        true,
        row.items[0].id,
      );
  if (idxHeading) {
    const indexRows = candidates.filter(
      (row) =>
        row.y > idxHeading.y &&
        /(?:\d+(?:\s*[,–—-]\s*\d+)*)\s*$/u.test(row.text) &&
        (/\p{L}/u.test(row.text) || pageNumber.test(row.text.trim())),
    );
    const indexEndings = new Set(indexRows);
    for (const row of indexRows)
      add(
        entryWithPrecedingLines(row, candidates, indexEndings, claimed, idxHeading.y),
        'index',
        true,
        row.items[0].id,
      );
  }
  const noteRows = allRows.filter(
    (row) =>
      !row.items.some((item) => claimed.has(item.id)) &&
      !headings.includes(row) &&
      !row.items.some((item) =>
        page.graphicRegions.some(
          (region) =>
            region.height > row.size * 3 &&
            region.width > row.size * 4 &&
            item.x + item.width / 2 >= region.x &&
            item.x + item.width / 2 <= region.x + region.width &&
            item.y + item.height / 2 >= region.y &&
            item.y + item.height / 2 <= region.y + region.height,
        ),
      ),
  );
  for (let index = 0; index < noteRows.length; index++) {
    const first = noteRows[index],
      noteLabel = markerLabel(first.items[0]?.text ?? '') ?? label(first.text),
      inNotes = Boolean(noteHeading && first.y > noteHeading.y);
    if (!noteLabel || (!inNotes && !(first.y > page.height * 0.73 && first.size < bodySize * 0.94)))
      continue;
    // Bare numeric tick rows near the page bottom are not explanatory footnotes.
    if (!inNotes && !/\p{L}{2}/u.test(first.text)) continue;
    if (/\b(?:19|20)\d{2}\b|doi|https?:/iu.test(first.text) && !inNotes) continue;
    const entries = [...first.items];
    let previous = first;
    while (index + 1 < noteRows.length) {
      const next = noteRows[index + 1],
        gap = next.y - previous.y - previous.height;
      if (
        next.items.some((item) => claimed.has(item.id)) ||
        markerLabel(next.items[0]?.text ?? '') ||
        label(next.text) ||
        gap < -1 ||
        gap > Math.max(first.size, next.size) * 1.4 ||
        Math.abs(next.size - first.size) > first.size * 0.2 ||
        Math.abs(next.x - first.x) > bodySize * 3 ||
        next.x > first.x + first.width
      )
        break;
      entries.push(...next.items);
      previous = next;
      index++;
    }
    add(entries, 'note', false, first.items[0].id);
  }
  return {
    blocks,
    lineNumbers: detectLineNumbers(page, claimed, bodySize),
    referenceIds: new Set(),
  };
}

function detectLineNumbers(
  page: SourcePage,
  claimed: Set<string>,
  bodySize: number,
): PendingLineNumber[] {
  const free = page.items.filter((item) => !claimed.has(item.id));
  const referenceIds = new Set(
    (page.structure ?? [])
      .filter((group) => group.role === 'Reference')
      .flatMap((group) => group.sourceIds),
  );
  const numberItems = free.filter(
    (item) =>
      /^\d{1,5}$/u.test(item.text.trim()) &&
      !referenceIds.has(item.id) &&
      item.width <= item.fontSize * 3.6 &&
      (item.artifact || item.fontSize <= bodySize * 1.05) &&
      (item.x + item.width < page.width * 0.15 || item.x > page.width * 0.86) &&
      !item.structureRoles?.some((role) =>
        [
          'Table',
          'TR',
          'TD',
          'TH',
          'L',
          'LI',
          'Note',
          'FENote',
          'TOC',
          'TOCI',
          'Index',
          'Reference',
        ].includes(role),
      ) &&
      !page.graphicRegions.some((region) => intersects(region, item)),
  );
  const matched: PendingLineNumber[] = [];
  for (const number of numberItems) {
    const left = number.x < page.width / 2;
    const row = free.filter(
      (item) =>
        item !== number &&
        item.text.trim().length >= 4 &&
        /\p{L}/u.test(item.text) &&
        item.fontSize >= number.fontSize * 0.95 &&
        (number.artifact ||
          number.fontSize < bodySize * 0.96 ||
          (item.text.trim().length >= 20 && item.width >= page.width * 0.35)) &&
        Math.abs(item.y + item.height / 2 - number.y - number.height / 2) <=
          Math.max(item.height, number.height) * 0.6 &&
        number.y + number.height / 2 >= item.y + item.height * 0.25 &&
        (left
          ? item.x >= number.x + number.width + 2 &&
            item.x - number.x - number.width <= bodySize * 4
          : item.x + item.width <= number.x - 2 && number.x - item.x - item.width <= bodySize * 4),
    );
    const target = row.sort((a, b) => a.x - b.x)[0];
    if (target) matched.push({ item: number, targetId: target.id });
    else {
      const object = page.graphicRegions.find(
        (region) =>
          Math.abs(region.y - number.y) <= bodySize &&
          (left
            ? region.x > number.x + number.width &&
              region.x - number.x - number.width < bodySize * 4
            : region.x + region.width < number.x &&
              number.x - region.x - region.width < bodySize * 4),
      );
      if (object) matched.push({ item: number, targetRect: object });
    }
  }
  const columns: PendingLineNumber[][] = [];
  for (const entry of matched) {
    const column = columns.find(
      (entries) =>
        Math.abs(entries[0].item.x - entry.item.x) <=
        Math.max(entry.item.fontSize, entries[0].item.fontSize) * 0.6,
    );
    if (column) column.push(entry);
    else columns.push([entry]);
  }
  return columns.flatMap((column) => {
    const entries = column.sort((a, b) => a.item.y - b.item.y);
    if (entries.length < 3) return [];
    const steps = entries
      .slice(1)
      .map((entry, index) => Number(entry.item.text) - Number(entries[index].item.text));
    const step = median(steps),
      gaps = entries.slice(1).map((entry, index) => entry.item.y - entries[index].item.y);
    if (
      ![1, 5, 10].includes(step) ||
      steps.some((value) => value !== step) ||
      gaps.some((gap) => gap <= 0 || gap > median(gaps) * 2.2)
    )
      return [];
    return entries;
  });
}

function taggedReferences(
  page: SourcePage,
): { items: SourceText[]; label: string; order: number }[] {
  const result: { items: SourceText[]; label: string; order: number }[] = [];
  const groups = new Map((page.structure ?? []).map((group) => [group.id, group]));
  const items = new Map(page.items.map((item) => [item.id, item]));
  for (const group of page.structure ?? []) {
    if (group.role !== 'Reference') continue;
    const entries = group.sourceIds.flatMap((id) =>
      items.get(id) && !items.get(id)!.artifact ? [items.get(id)!] : [],
    );
    let parent = group.parentId ? groups.get(group.parentId) : undefined;
    let excluded = false;
    const visited = new Set<string>();
    while (parent && !visited.has(parent.id)) {
      visited.add(parent.id);
      if (noteRoles.has(parent.role) || ['TOC', 'TOCI', 'Index'].includes(parent.role)) {
        excluded = true;
        break;
      }
      parent = parent.parentId ? groups.get(parent.parentId) : undefined;
    }
    if (
      excluded ||
      entries.some((item) =>
        item.structureRoles?.some(
          (role) => noteRoles.has(role) || ['TOC', 'TOCI', 'Index'].includes(role),
        ),
      )
    )
      continue;
    const value = markerLabel(entries.map((item) => item.text).join(''));
    if (value) result.push({ items: entries, label: value, order: group.order });
  }
  return result.sort((a, b) => b.items.length - a.items.length || a.order - b.order);
}

/** A tiny numeric superscript is a note reference only when a note label supports it. */
export function noteMarkerIds(page: SourcePage, labels: Set<string>): Set<string> {
  const ids = new Set<string>();
  for (const group of taggedReferences(page)) group.items.forEach((item) => ids.add(item.id));
  for (const item of page.items) {
    const value = markerLabel(item.text);
    if (!value || !labels.has(value) || item.structureRoles?.some((role) => noteRoles.has(role)))
      continue;
    const adjacent = page.items.find(
      (other) =>
        other.id !== item.id &&
        other.text.trim().length >= 4 &&
        /\p{L}/u.test(other.text) &&
        !/math|symbol|cmsy|cmmi|cmex|msam|msbm/iu.test(other.fontName) &&
        other.fontSize > item.fontSize * 1.2 &&
        item.y < other.y + other.height * 0.45 &&
        item.y + item.height > other.y - other.height * 0.3 &&
        item.x >= other.x + other.width - other.fontSize * 0.5 &&
        item.x - other.x - other.width < other.fontSize * 1.5,
    );
    if (adjacent) ids.add(item.id);
  }
  return ids;
}

export function resolveNoteReferences(
  source: SourceDocument,
  blocks: ReadingBlock[],
  markerIds: Map<number, Set<string>>,
): ReadingReference[] {
  const references: ReadingReference[] = [],
    notes = blocks.filter((block) => block.semantic === 'note' && block.noteLabel);
  const owners = new Map(
    blocks
      .filter((block) => block.kind !== 'lineNumber')
      .flatMap((block) => block.sourceIds.map((id) => [id, block] as const)),
  );
  for (const page of source.pages) {
    const handled = new Set<string>();
    const addReference = (item: SourceText, value: string) => {
      const owner = owners.get(item.id);
      if (!owner || !value || owner.semantic === 'note' || owner.running) return;
      const matching = notes.filter((note) => note.noteLabel === value && note.id !== owner.id),
        local = matching.filter((note) => note.sourcePage === page.number);
      const target =
        local.length === 1
          ? local[0]
          : !local.length && matching.length === 1 && matching[0].sourcePage >= page.number
            ? matching[0]
            : undefined;
      if (target)
        references.push({
          id: `${item.id}:${target.id}`,
          source: { blockId: owner.id, sourceId: item.id },
          targetBlockId: target.id,
        });
    };
    for (const group of taggedReferences(page)) {
      if (group.items.some((item) => handled.has(item.id))) continue;
      group.items.forEach((item) => handled.add(item.id));
      if (group.items[0]) addReference(group.items[0], group.label);
    }
    for (const item of page.items.filter(
      (entry) => !handled.has(entry.id) && markerIds.get(page.number)?.has(entry.id),
    )) {
      const value = markerLabel(item.text);
      if (value) addReference(item, value);
    }
  }
  return references;
}
