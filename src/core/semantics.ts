import { clampRect, intersects, union } from './geometry';
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
const indexHeading = /^(?:index|subject\s+index|색\s*인|찾아보기)\s*$/iu;
const notesHeading = /^(?:endnotes?|footnotes?|notes|미주|각주|주석)\s*$/iu;
const pageNumber = /^(?:\d{1,5}|[ivxlcdm]{1,10})(?:\s*[,–—-]\s*(?:\d{1,5}|[ivxlcdm]{1,10}))*$/iu;

export function normalizedSourceText(text: string): string {
  return text.normalize('NFKC').replace(/[\s\u00ad]/gu, '');
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
          item.x - previous.x - previous.width >
            Math.min(item.fontSize, previous.fontSize) * 0.15 &&
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
        /(?:\.{2,}|…|·{3,})\s*(?:\d+|[ivxlcdm]+)\s*$/iu.test(row.text) ||
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
      const newLabel = /^\s*\d+(?:\.\d+)*[.)]?\s+\p{L}/u.test(rows(entry.items)[0].text);
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
      !/\p{L}/u.test(previous.text) ||
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
        const overlapping = blocks.filter((block) => intersects(rect, block.rect, 0.2));
        for (const block of overlapping) {
          blocks.splice(blocks.indexOf(block), 1);
          for (const id of block.sourceIds) claimed.delete(id);
          rect = union([rect, block.rect]);
        }
        const included = page.items.filter(
          (item) => !claimed.has(item.id) && intersects(rect, item, 0.2),
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
    blocks.push(block);
    free.forEach((item) => claimed.add(item.id));
  };
  for (const group of [...structures].sort((a, b) => a.order - b.order)) {
    if (!noteRoles.has(group.role) && !['TOCI', 'LI', 'P', 'Index', 'TOC'].includes(group.role))
      continue;
    const entries = group.sourceIds.flatMap((id) =>
      items.get(id) && !items.get(id)!.artifact ? [items.get(id)!] : [],
    );
    if (noteRoles.has(group.role)) {
      add(entries, 'note', false, group.id);
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
  const headings = allRows.filter(
    (row) =>
      contentsHeading.test(row.text) || indexHeading.test(row.text) || notesHeading.test(row.text),
  );
  const tocHeading = headings.find((row) => contentsHeading.test(row.text)),
    idxHeading = headings.find((row) => indexHeading.test(row.text)),
    noteHeading = headings.find((row) => notesHeading.test(row.text));
  const candidates = allRows.filter(
    (row) => !row.items.some((item) => claimed.has(item.id)) && !headings.includes(row),
  );
  const marginNumberIds = new Set(
    detectLineNumbers(page, claimed, bodySize).map((entry) => entry.item.id),
  );
  const referenceIds = new Set(
    structures.filter((group) => group.role === 'Reference').flatMap((group) => group.sourceIds),
  );
  const tocRows = candidates.filter(
    (row) =>
      /(?:\.{2,}|…|·{3,})\s*(?:\d+|[ivxlcdm]+)\s*$/iu.test(row.text) ||
      (row.items.length >= 2 &&
        (tocHeading ||
          (!marginNumberIds.has(row.items.at(-1)!.id) &&
            !referenceIds.has(row.items.at(-1)!.id) &&
            !row.items.at(-1)!.structureRoles?.includes('Reference'))) &&
        row.items.at(-1)!.y + row.items.at(-1)!.height / 2 >=
          row.items.at(-2)!.y + row.items.at(-2)!.height * 0.25 &&
        pageNumber.test(row.items.at(-1)!.text.trim()) &&
        row.items.at(-1)!.x > page.width * 0.65 &&
        row.items.at(-1)!.x - (row.items.at(-2)!.x + row.items.at(-2)!.width) > bodySize * 2 &&
        row.items[0].text.trim().length >= 4),
  );
  const tocEndings = new Set(tocRows);
  if (tocHeading || tocRows.length >= 3)
    for (const row of tocRows.filter((entry) => entry.y > (tocHeading?.y ?? -Infinity)))
      add(
        entryWithPrecedingLines(row, candidates, tocEndings, claimed, tocHeading?.y ?? -Infinity),
        'toc',
        true,
        row.items[0].id,
      );
  if (idxHeading) {
    const indexRows = candidates.filter(
      (row) =>
        row.y > idxHeading.y &&
        /(?:\d+(?:\s*[,–—-]\s*\d+)*)\s*$/u.test(row.text) &&
        /\p{L}/u.test(row.text),
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
