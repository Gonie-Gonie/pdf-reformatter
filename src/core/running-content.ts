import { intersects, union } from './geometry';
import type { SourceDocument, SourcePage, SourceText } from './model';

export interface RunningContent {
  headerIds: string[];
  footerIds: string[];
  pageNumberIds: string[];
}
interface Folio {
  item: SourceText;
  value: number;
  roman: boolean;
}
interface MarginRow {
  page: SourcePage;
  items: SourceText[];
  folios: Folio[];
  edge: 'header' | 'footer';
  shape: string;
  signature: string;
  artifact: boolean;
  embeddedFolio: boolean;
  strictEdge: boolean;
}
const excludedRoles = new Set([
  'Table',
  'TR',
  'TD',
  'TH',
  'Caption',
  'Note',
  'FENote',
  'Reference',
  'TOC',
  'TOCI',
  'Index',
]);
const romanPattern =
  /^(?=[MDCLXVI]+$)M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/u;

function median(values: number[]): number {
  const sorted = values
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 12;
}
function folioValue(text: string): { value: number; roman: boolean } | undefined {
  const raw = text.normalize('NFKC').trim();
  const counter =
    /^(?:(?:page|p\.)\s*)?([1-9]\d{0,4})(?:\s*(?:of|\/)\s*[1-9]\d{0,4}|\s*쪽)?$/iu.exec(raw);
  const value = counter?.[1] ?? raw;
  if (/^[1-9]\d{0,4}$/u.test(value)) return { value: Number(value), roman: false };
  const upper = value.toUpperCase();
  if (!romanPattern.test(upper)) return undefined;
  const digits: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let number = 0;
  for (let index = 0; index < upper.length; index++) {
    const digit = digits[upper[index]];
    number += digit < (digits[upper[index + 1]] ?? 0) ? -digit : digit;
  }
  // Lowercase front-matter folios are short. Ordinary words such as "mix" are not folios.
  if (number <= 0 || (value === value.toLowerCase() && number > 50)) return undefined;
  return { value: number, roman: true };
}
function textRows(items: SourceText[]): SourceText[][] {
  const rows: SourceText[][] = [];
  for (const item of [...items].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const row = rows.find((entries) => {
      const rect = union(entries);
      const overlap =
        Math.min(rect.y + rect.height, item.y + item.height) - Math.max(rect.y, item.y);
      return (
        overlap > Math.min(rect.height, item.height) * 0.35 ||
        Math.abs(rect.y + rect.height / 2 - item.y - item.height / 2) <
          Math.max(rect.height, item.height) * 0.4
      );
    });
    if (row) row.push(item);
    else rows.push([item]);
  }
  return rows.map((row) => row.sort((a, b) => a.x - b.x));
}
function horizontalAnchor(items: SourceText[], page: SourcePage): string {
  const rect = union(items);
  const left = rect.x;
  const right = page.width - rect.x - rect.width;
  if (left < page.width * 0.25 && left < right) return `l${Math.round(left / page.width / 0.04)}`;
  if (right < page.width * 0.25 && right <= left)
    return `r${Math.round(right / page.width / 0.04)}`;
  return `c${Math.round((rect.x + rect.width / 2) / page.width / 0.04)}`;
}

function marginRows(page: SourcePage): MarginRow[] {
  if (
    !Number.isFinite(page.width) ||
    !Number.isFinite(page.height) ||
    page.width <= 0 ||
    page.height <= 0 ||
    page.rotation % 360 !== 0
  )
    return [];
  const items = page.items.filter(
    (item) =>
      item.text.trim() &&
      [item.x, item.y, item.width, item.height, item.fontSize].every(Number.isFinite) &&
      item.width >= 0 &&
      item.height > 0 &&
      item.fontSize > 0,
  );
  const bodyItems = items.filter(
    (item) =>
      item.text.trim().length >= 15 &&
      item.y > page.height * 0.14 &&
      item.y + item.height < page.height * 0.86,
  );
  const bodySize = median(
    (bodyItems.length ? bodyItems : items.filter((item) => item.text.trim().length >= 12)).map(
      (item) => item.fontSize,
    ),
  );
  const rows = textRows(items);
  const result: MarginRow[] = [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const rect = union(row);
    const edge =
      rect.y + rect.height <= page.height * 0.135
        ? 'header'
        : rect.y >= page.height * 0.865
          ? 'footer'
          : undefined;
    if (
      !edge ||
      rect.height > bodySize * 1.8 ||
      row.some((item) => item.structureRoles?.some((role) => excludedRoles.has(role)))
    )
      continue;
    // A last line of a short body paragraph is not a running head merely because
    // a paragraph gap follows it. Only separate folios may lie farther out.
    const farther = edge === 'header' ? rows.slice(0, index) : rows.slice(index + 1);
    if (farther.some((entries) => entries.some((item) => !folioValue(item.text)))) continue;
    const size = median(row.map((item) => item.fontSize));
    const artifact = row.every((item) => item.artifact);
    const text = row
      .map((item) => item.text.trim())
      .join(' ')
      .normalize('NFKC');
    if (
      text.length > 180 ||
      size > bodySize * (artifact ? 1.5 : 1.08) ||
      /^(?:fig(?:ure)?\.?|table|그림|표)\s*\d/iu.test(text) ||
      /^(?:\[\d+\]|\d+[.)]|[*†‡])\s*\S/u.test(text) ||
      /^(?:\d+\.)+\d*\s+\p{L}/u.test(text) ||
      /\bdoi\b|https?:\/\//iu.test(text) ||
      (!artifact &&
        row.some((item) => item.structureRoles?.some((role) => /^H[1-6]?$/u.test(role))))
    )
      continue;
    if (
      edge === 'footer' &&
      !artifact &&
      rect.y < page.height * 0.955 &&
      /^(?:\[\d+\]|\d{1,3}[.)]?|[*†‡])\s+\p{L}/u.test(text)
    )
      continue;
    const neighbor = edge === 'header' ? rows[index + 1] : rows[index - 1];
    if (neighbor) {
      const box = union(neighbor);
      const gap = edge === 'header' ? box.y - rect.y - rect.height : rect.y - box.y - box.height;
      if (gap < Math.max(5.5, size * 0.65)) continue;
    }
    // Compact tables/illustrations can have repeated headings; broad conservative masks are
    // not used as evidence because they may include unrelated body text.
    if (
      !artifact &&
      page.graphicRegions.some(
        (graphic) =>
          graphic.width > page.width * 0.2 &&
          graphic.height > bodySize * 2.5 &&
          graphic.height < page.height * 0.6 &&
          intersects(graphic, rect),
      )
    )
      continue;
    const folios = row.flatMap((item): Folio[] => {
      const value = folioValue(item.text);
      const widthLimit = /(?:page|p\.|of|\/|쪽)/iu.test(item.text) ? 12 : 4.5;
      if (!value || item.width > item.fontSize * widthLimit || item.fontSize > bodySize * 1.08)
        return [];
      const center = item.x + item.width / 2;
      const aligned =
        center < page.width * 0.3 ||
        center > page.width * 0.7 ||
        Math.abs(center - page.width / 2) < page.width * 0.08;
      return aligned ? [{ item, ...value }] : [];
    });
    const folioIds = new Set(folios.map((folio) => folio.item.id));
    const textItems = row.filter((item) => !folioIds.has(item.id));
    let signature = textItems
      .map((item) => item.text.trim())
      .join(' ')
      .normalize('NFKC')
      .replace(/\s+/gu, ' ')
      .trim();
    let embeddedFolio = false;
    if (signature.length > 10 && rect.width > page.width * 0.45) {
      const parts = signature.split(' ');
      if (folioValue(parts[0])) {
        parts.shift();
        embeddedFolio = true;
      }
      if (folioValue(parts.at(-1) ?? '')) {
        parts.pop();
        embeddedFolio = true;
      }
      signature = parts.join(' ');
    }
    if (signature && (!/\p{L}/u.test(signature) || signature.length < 4)) continue;
    const style = row.some((item) => /bold|black|heavy/iu.test(item.fontName)) ? 'b' : 'n';
    const position = Math.round((rect.y + rect.height / 2) / page.height / 0.007);
    const shape = `${edge}:${position}:${Math.round(size * 2)}:${style}:${horizontalAnchor(textItems.length ? textItems : row, page)}`;
    result.push({
      page,
      items: row,
      folios,
      edge,
      shape,
      signature: signature.toLocaleLowerCase('en'),
      artifact,
      embeddedFolio,
      strictEdge:
        edge === 'header'
          ? rect.y + rect.height < page.height * 0.045
          : rect.y > page.height * 0.955,
    });
  }
  return result;
}
function uniquePages(rows: MarginRow[]): Set<number> {
  return new Set(rows.map((row) => row.page.number));
}

/** Identify running page furniture without changing or discarding any source text. */
export function detectRunningContent(source: SourceDocument): Map<number, RunningContent> {
  const rows = source.pages.flatMap(marginRows);
  const selected = new Set<MarginRow>();
  const recognizedFolios = new Set<string>();
  const folioGroups = new Map<string, { row: MarginRow; folio: Folio }[]>();
  for (const row of rows)
    for (const folio of row.folios) {
      const rect = folio.item;
      const key = `${row.edge}:${Math.round((rect.y + rect.height / 2) / row.page.height / 0.007)}:${horizontalAnchor([rect], row.page)}:${folio.roman}:${folio.value - row.page.number}`;
      const group = folioGroups.get(key) ?? [];
      group.push({ row, folio });
      folioGroups.set(key, group);
    }
  for (const group of folioGroups.values()) {
    const recurring = new Set(group.map((entry) => entry.row.page.number)).size >= 2;
    for (const { row, folio } of group) {
      if (recurring || (row.items.length === 1 && (row.artifact || row.strictEdge)))
        recognizedFolios.add(folio.item.id);
    }
  }
  const exact = new Map<string, MarginRow[]>();
  const shapes = new Map<string, MarginRow[]>();
  for (const row of rows) {
    if (!row.signature) continue;
    const key = `${row.shape}:${row.signature}`;
    const matches = exact.get(key) ?? [];
    matches.push(row);
    exact.set(key, matches);
    const shape = shapes.get(row.shape) ?? [];
    shape.push(row);
    shapes.set(row.shape, shape);
  }
  const provenShapes = new Set<string>();
  const hasFolio = (row: MarginRow) =>
    row.embeddedFolio || row.folios.some((folio) => recognizedFolios.has(folio.item.id));
  for (const group of exact.values()) {
    const pages = [...uniquePages(group)].sort((a, b) => a - b);
    const parityPair = pages.some(
      (page, index) => index > 0 && (page - pages[index - 1]) % 2 === 0,
    );
    const repeated =
      pages.length >= 3 ||
      (pages.length >= 2 &&
        (group.some((row) => row.artifact || hasFolio(row)) ||
          (source.pages.length >= 4 && parityPair)));
    if (!repeated) continue;
    group.forEach((row) => selected.add(row));
    provenShapes.add(group[0].shape);
  }
  for (const [shape, group] of shapes) {
    if (uniquePages(group).size >= 3 && group.every((row) => row.artifact || hasFolio(row)))
      provenShapes.add(shape);
    for (const row of group)
      if (provenShapes.has(shape) && (row.artifact || hasFolio(row))) selected.add(row);
  }
  const result = new Map<number, RunningContent>();
  const add = (page: number): RunningContent => {
    let content = result.get(page);
    if (!content) {
      content = { headerIds: [], footerIds: [], pageNumberIds: [] };
      result.set(page, content);
    }
    return content;
  };
  for (const row of rows) {
    const folios = row.folios.filter((folio) => recognizedFolios.has(folio.item.id));
    const accepted = selected.has(row);
    if (!accepted && !folios.length) continue;
    const content = add(row.page.number);
    for (const folio of folios) content.pageNumberIds.push(folio.item.id);
    if (!accepted) continue;
    const folioIds = new Set(folios.map((folio) => folio.item.id));
    content[row.edge === 'header' ? 'headerIds' : 'footerIds'].push(
      ...row.items.filter((item) => !folioIds.has(item.id)).map((item) => item.id),
    );
  }
  for (const content of result.values()) {
    content.headerIds = [...new Set(content.headerIds)];
    content.footerIds = [...new Set(content.footerIds)];
    content.pageNumberIds = [...new Set(content.pageNumberIds)];
  }
  return result;
}
