import { finiteRect, union } from './geometry';
import type { Rect, SourcePage, SourceText } from './model';

interface TextRow {
  items: SourceText[];
  rect: Rect;
  text: string;
  fontSize: number;
}

function rows(items: SourceText[]): TextRow[] {
  const grouped: SourceText[][] = [];
  for (const item of [...items].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const baseline = item.baselineY ?? item.y + item.height;
    const row = grouped.find((members) => {
      const first = members[0];
      return (
        Math.abs(baseline - (first.baselineY ?? first.y + first.height)) <=
        Math.min(item.fontSize, first.fontSize) * 0.35
      );
    });
    if (row) row.push(item);
    else grouped.push([item]);
  }
  return grouped.map((members) => ({
    items: members,
    rect: union(members),
    text: members
      .sort((a, b) => a.x - b.x)
      .map((item) => item.text)
      .join(' ')
      .replace(/\s+/gu, ' ')
      .trim(),
    fontSize: Math.max(...members.map((item) => item.fontSize)),
  }));
}

function bodyFontSize(page: SourcePage, items: SourceText[]): number {
  const counts = new Map<number, number>();
  for (const item of items) {
    if (item.y < page.height * 0.2 || item.artifact) continue;
    counts.set(item.fontSize, (counts.get(item.fontSize) ?? 0) + item.text.trim().length);
  }
  if (!counts.size) return 0;
  return [...counts].sort((a, b) => b[1] - a[1])[0][0];
}

function caption(row: TextRow, nonMastheadIds: Set<string>): boolean {
  return (
    row.items.some(
      (item) =>
        nonMastheadIds.has(item.id) ||
        item.structureRoles?.some((role) => /^(?:Caption|Figure|Table|Formula|Note)$/iu.test(role)),
    ) || /^(?:fig(?:ure)?\.?|table|plate|그림|표)\s*[\dIVX]/iu.test(row.text)
  );
}

/** A masthead is kept once, before the article title, rather than entering its columns. */
export function mastheadBoundary(page: SourcePage): number | undefined {
  if (!Number.isFinite(page.width) || !Number.isFinite(page.height)) return undefined;
  if (page.width <= 0 || page.height <= 0) return undefined;
  const items = page.items.filter(
    (item) =>
      finiteRect(item) && item.fontSize > 0 && Number.isFinite(item.fontSize) && item.text.trim(),
  );
  const textRows = rows(items);
  const bodySize = bodyFontSize(page, items);
  if (!bodySize) return undefined;
  const h1Ids = new Set(
    page.structure?.filter((group) => group.role === 'H1').flatMap((group) => group.sourceIds),
  );
  const nonMastheadIds = new Set(
    page.structure
      ?.filter((group) => /^(?:Caption|Figure|Table|Formula|Note)$/iu.test(group.role))
      .flatMap((group) => group.sourceIds),
  );
  const titles = textRows.filter((row) => {
    const tagged = row.items.some(
      (item) => h1Ids.has(item.id) || item.structureRoles?.includes('H1'),
    );
    return (
      row.rect.y <= page.height * 0.32 &&
      row.rect.width >= page.width * 0.2 &&
      row.text.replace(/\s/gu, '').length >= 20 &&
      row.fontSize >= bodySize * (tagged ? 1.2 : 1.4) &&
      !caption(row, nonMastheadIds)
    );
  });
  const graphics = page.graphicRegions.filter(finiteRect);
  for (const title of titles) {
    const candidates = graphics.filter((graphic) => {
      const bottom = graphic.y + graphic.height;
      const gap = title.rect.y - bottom;
      return (
        graphic.width >= page.width * 0.65 &&
        graphic.y <= page.height * 0.23 &&
        bottom <= page.height * 0.27 &&
        gap >= 4 &&
        gap <= Math.max(24, bodySize * 3)
      );
    });
    for (const graphic of candidates) {
      const boundary = graphic.y + graphic.height;
      const mergedBand =
        graphic.y <= page.height * 0.1 &&
        graphic.height >= Math.max(8, page.height * 0.02) &&
        graphic.height <= page.height * 0.2;
      const separateRule =
        graphic.height <= Math.max(2, bodySize * 0.6) &&
        graphics.some(
          (logo) =>
            logo !== graphic &&
            logo.y <= page.height * 0.1 &&
            logo.y + logo.height <= graphic.y + 2 &&
            logo.width >= bodySize * 2 &&
            logo.height >= bodySize * 2 &&
            logo.width * logo.height >= bodySize ** 2 * 6,
        );
      if (!mergedBand && !separateRule) continue;
      const headerRows = textRows.filter(
        (row) => row.rect.y < boundary && row.rect.y + row.rect.height <= boundary + 2,
      );
      if (
        !headerRows.some((row) => row.text.length >= 8 && row.fontSize <= title.fontSize * 0.95)
      ) {
        continue;
      }
      const beforeTitle = textRows.filter((row) => row.rect.y < title.rect.y - 1);
      if (
        beforeTitle.some(
          (row) =>
            caption(row, nonMastheadIds) ||
            (row.text.length >= 85 && row.fontSize >= bodySize * 0.9),
        )
      ) {
        continue;
      }
      return boundary;
    }
  }
  return undefined;
}
