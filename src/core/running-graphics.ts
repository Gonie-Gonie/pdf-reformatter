import { finiteRect, intersects, union } from './geometry';
import type { Rect, SourceDocument, SourcePage, SourceText } from './model';

export interface RunningGraphicContent {
  regions: Rect[];
  headerIds: string[];
  pageNumberIds: string[];
}

const excludedRole = /^(?:Figure|Caption|Table|TR|TD|TH|Formula|Note|FENote|H[1-6])$/u;

function headerRows(items: SourceText[]): SourceText[][] {
  const rows: SourceText[][] = [];
  for (const item of [...items].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const row = rows.find((entries) => {
      const first = entries[0];
      return (
        Math.abs(
          (first.baselineY ?? first.y + first.height) - (item.baselineY ?? item.y + item.height),
        ) <=
        Math.min(first.fontSize, item.fontSize) * 0.35
      );
    });
    if (row) row.push(item);
    else rows.push([item]);
  }
  return rows.map((row) => row.sort((a, b) => a.x - b.x));
}

function bodyFontSize(items: SourceText[], page: SourcePage): number {
  const counts = new Map<number, number>();
  for (const item of items) {
    if (item.artifact || item.y < page.height * 0.12 || item.y > page.height * 0.88) continue;
    counts.set(item.fontSize, (counts.get(item.fontSize) ?? 0) + item.text.trim().length);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
}

function folio(item: SourceText, page: SourcePage): boolean {
  const value = item.text.normalize('NFKC').trim();
  const numeric = /^\d{1,5}$/u.test(value);
  const roman = /^(?:[ivxlcdm]{1,8}|[IVXLCDM]{1,8})$/u.test(value);
  const center = item.x + item.width / 2;
  const edge = numeric ? 0.2 : 0.12;
  return (
    (numeric || roman) &&
    item.width <= item.fontSize * 4 &&
    (center < page.width * edge || center > page.width * (1 - edge))
  );
}

/** Tiny margin artwork needs both Artifact-marked running words and a separate folio. */
export function runningGraphicContent(source: SourceDocument): Map<number, RunningGraphicContent> {
  const result = new Map<number, RunningGraphicContent>();
  for (const page of source.pages) {
    if (
      !Number.isFinite(page.width) ||
      !Number.isFinite(page.height) ||
      page.width <= 0 ||
      page.height <= 0 ||
      page.rotation % 360 !== 0
    ) {
      continue;
    }
    const items = page.items.filter(
      (item) =>
        finiteRect(item) && Number.isFinite(item.fontSize) && item.fontSize > 0 && item.text.trim(),
    );
    const bodySize = bodyFontSize(items, page);
    if (!bodySize) continue;
    const excludedIds = new Set(
      page.structure
        ?.filter((group) => excludedRole.test(group.role))
        .flatMap((group) => group.sourceIds),
    );
    const rows = headerRows(
      items.filter(
        (item) =>
          item.artifact &&
          item.y >= 0 &&
          item.y + item.height <= page.height * 0.1 &&
          item.fontSize <= bodySize * 1.2,
      ),
    );
    const regions: Rect[] = [];
    const headerIds = new Set<string>();
    const pageNumberIds = new Set<string>();
    const graphics = page.graphicRegions.filter(finiteRect);
    for (const graphic of graphics) {
      if (
        graphic.y < 0 ||
        graphic.y > page.height * 0.08 ||
        graphic.y + graphic.height > page.height * 0.1 ||
        graphic.width > page.width * 0.1 ||
        graphic.height > page.height * 0.08 ||
        graphic.width > bodySize * 4 ||
        graphic.height > bodySize * 4 ||
        graphic.width < 2 ||
        graphic.height < 2
      ) {
        continue;
      }
      for (const row of rows) {
        const rect = union(row);
        const size = Math.max(...row.map((item) => item.fontSize));
        const folios = row.filter(
          (item, index) => (index === 0 || index === row.length - 1) && folio(item, page),
        );
        const folioIds = new Set(folios.map((item) => item.id));
        const words = row.filter((item) => !folioIds.has(item.id));
        const title = words.map((item) => item.text.trim()).join(' ');
        if (
          !folios.length ||
          title.replace(/[^\p{L}]/gu, '').length < 4 ||
          title.length > 180 ||
          /^(?:fig(?:ure)?\.?|table|plate|그림|표)\s*\d/iu.test(title) ||
          row.some(
            (item) =>
              excludedIds.has(item.id) ||
              item.structureRoles?.some((role) => excludedRole.test(role)),
          ) ||
          Math.abs(graphic.y + graphic.height / 2 - rect.y - rect.height / 2) >
            Math.max(size * 0.75, graphic.height * 0.4) ||
          !row.some(
            (item) =>
              Math.max(item.x - graphic.x - graphic.width, graphic.x - item.x - item.width, 0) <=
              size * 2,
          )
        ) {
          continue;
        }
        const cluster = union([graphic, rect]);
        if (
          items.some((item) => !item.artifact && intersects(item, cluster, size)) ||
          graphics.some(
            (other) =>
              other !== graphic &&
              (other.width > page.width * 0.1 || other.height > bodySize * 4) &&
              intersects(other, cluster, size),
          )
        ) {
          continue;
        }
        regions.push({ ...graphic });
        for (const item of words) headerIds.add(item.id);
        for (const item of folios) pageNumberIds.add(item.id);
        break;
      }
    }
    if (regions.length) {
      result.set(page.number, {
        regions,
        headerIds: [...headerIds],
        pageNumberIds: [...pageNumberIds],
      });
    }
  }
  return result;
}
