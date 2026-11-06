import { clampRect, finiteRect, intersects, union } from './geometry';
import type { Rect, SourcePage, SourceText } from './model';

export interface PreservationRegion {
  rect: Rect;
  reason: string;
  displayMath?: boolean;
}

/** Font boxes can overlap adjacent baselines even when their visible glyphs do not. */
export function ownsPreservedText(region: Rect, item: SourceText): boolean {
  const overlapX =
    Math.min(region.x + region.width, item.x + item.width) - Math.max(region.x, item.x);
  const overlapY =
    Math.min(region.y + region.height, item.y + item.height) - Math.max(region.y, item.y);
  const horizontal =
    item.width <= 1e-6
      ? item.x >= region.x && item.x <= region.x + region.width
      : overlapX > Math.min(1, item.width * 0.25);
  return horizontal && overlapY >= item.height * 0.45;
}

function regionsOverlap(a: Rect, b: Rect): boolean {
  const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return (
    overlapX > Math.min(1, Math.min(a.width, b.width) * 0.25) &&
    overlapY >= Math.min(a.height, b.height) * 0.45
  );
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function graphicEdgeLabel(region: Rect, item: SourceText): boolean {
  const value = item.text.trim();
  if (
    !/^[+−-]?\d+(?:[.,]\d+)?\s*(?:%|°[CF]?|mm|cm|m|km|in|ft|yd|s|ms|min|h|Hz|kHz|W|kW|MW|Wh|kWh|MWh|V|kV|A|mA|Pa|kPa|MPa|kg|g|N|kN|K)?$/u.test(
      value,
    ) ||
    value.length > 20 ||
    item.width <= 0 ||
    item.width > item.fontSize * 6 ||
    item.width > region.width * 0.4 ||
    item.artifact ||
    item.structureRoles?.some((role) => /^(?:Caption|Note|FENote|Reference)$/u.test(role))
  )
    return false;
  const overlapX =
    Math.min(region.x + region.width, item.x + item.width) - Math.max(region.x, item.x);
  const overlapY =
    Math.min(region.y + region.height, item.y + item.height) - Math.max(region.y, item.y);
  return overlapX >= item.width * 0.7 && overlapY >= item.height * 0.25;
}

/** Close whole-item ownership without growing through the padding between dense prose rows. */
export function closePreservationRegions(
  page: Pick<SourcePage, 'width' | 'height' | 'items'>,
  seeds: PreservationRegion[],
): PreservationRegion[] {
  const regions = seeds
    .filter((region) => finiteRect(region.rect))
    .map((region) => ({ ...region, rect: clampRect(region.rect, page.width, page.height) }))
    .filter((region) => finiteRect(region.rect));
  for (const region of regions) {
    if (region.reason !== '그림·표·벡터 도형을 원문 모양으로 보존' || region.displayMath) continue;
    // Use the initial figure edge only, so labels cannot form an outward growth chain.
    const labels = page.items.filter((item) => graphicEdgeLabel(region.rect, item));
    if (labels.length)
      region.rect = clampRect(union([region.rect, ...labels]), page.width, page.height);
  }
  let changed = true;
  let passes = 0;
  while (changed && passes++ < page.items.length + regions.length + 2) {
    changed = false;
    for (const region of regions) {
      const items = page.items.filter((item) => ownsPreservedText(region.rect, item));
      const expanded = clampRect(union([region.rect, ...items]), page.width, page.height);
      if (!sameRect(expanded, region.rect)) {
        region.rect = expanded;
        changed = true;
      }
    }
    for (let index = 0; index < regions.length; index++) {
      for (let other = regions.length - 1; other > index; other--) {
        const a = regions[index];
        const b = regions[other];
        const sharedItem = page.items.some(
          (item) => ownsPreservedText(a.rect, item) && ownsPreservedText(b.rect, item),
        );
        if (!sharedItem && !regionsOverlap(a.rect, b.rect)) continue;
        a.rect = union([a.rect, b.rect]);
        if (a.reason !== b.reason)
          a.reason = /수식/u.test(a.reason + b.reason)
            ? '수식·도형과 인접 문자를 하나의 원문 영역으로 보존'
            : '그림·회전 문자와 인접 영역을 함께 보존';
        a.displayMath ||= b.displayMath;
        regions.splice(other, 1);
        changed = true;
      }
    }
  }
  return regions;
}

/** Remove neighboring prose slivers from a single inline-math row's raster crop. */
export function preservedRasterRect(
  page: Pick<SourcePage, 'items' | 'graphicRegions'>,
  region: PreservationRegion,
  owned: SourceText[],
): Rect {
  const original = region.rect;
  if (
    region.displayMath ||
    !/^수식 또는 첨자가 포함된 줄/u.test(region.reason) ||
    !owned.length ||
    owned.some((item) => item.preserve || Math.abs(item.rotation ?? 0) > 0.1) ||
    page.graphicRegions.some((graphic) => intersects(original, graphic))
  )
    return original;
  const centers = owned.map((item) => item.y + item.height / 2);
  const first = Math.min(...centers),
    last = Math.max(...centers);
  const fontSize = Math.max(...owned.map((item) => item.fontSize));
  if (
    !Number.isFinite(fontSize) ||
    fontSize <= 0 ||
    last - first > fontSize * 0.65 ||
    original.height > fontSize * 2.8
  )
    return original;
  const ids = new Set(owned.map((item) => item.id));
  const neighbors = page.items.filter((item) => {
    if (ids.has(item.id) || item.preserve || Math.abs(item.rotation ?? 0) > 0.1) return false;
    const overlap =
      Math.min(original.x + original.width, item.x + item.width) - Math.max(original.x, item.x);
    return overlap > Math.max(1, Math.min(original.width * 0.2, item.width * 0.5));
  });
  const above = neighbors
    .map((item) => item.y + item.height / 2)
    .filter((center) => center < first);
  const below = neighbors.map((item) => item.y + item.height / 2).filter((center) => center > last);
  const top = above.length
    ? Math.max(original.y, Math.ceil((Math.max(...above) + first) / 2))
    : original.y;
  const bottom = below.length
    ? Math.min(original.y + original.height, Math.floor((Math.min(...below) + last) / 2))
    : original.y + original.height;
  if (top === original.y && bottom === original.y + original.height) return original;
  const maxTrim = Math.min(fontSize * 0.6, original.height * 0.3);
  const crop = { x: original.x, y: top, width: original.width, height: bottom - top };
  if (
    !finiteRect(crop) ||
    top - original.y > maxTrim ||
    original.y + original.height - bottom > maxTrim ||
    owned.some((item) => !ownsPreservedText(crop, item))
  )
    return original;
  return crop;
}
