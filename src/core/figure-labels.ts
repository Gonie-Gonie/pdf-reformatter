import { finiteRect, intersects, union } from './geometry';
import type { Rect, SourceText } from './model';

function compactLabel(item: SourceText): boolean {
  const value = item.text.trim();
  return (
    finiteRect(item) &&
    Number.isFinite(item.fontSize) &&
    item.fontSize > 0 &&
    value.length > 0 &&
    value.length <= 64 &&
    value.split(/\s+/u).length <= 5 &&
    !/^[（(]\s*\d+(?:\s*[.:]\s*\d+)+[a-z]?\s*[)）]$/iu.test(value) &&
    !/[.!?]\s*$/u.test(value) &&
    !/^(?:fig(?:ure)?\.?|table|eq(?:uation)?\.?|note|source|그림|표|각주|미주)\s*(?:\d|[:.]|\s)/iu.test(
      value,
    ) &&
    !item.artifact &&
    !item.structureRoles?.some((role) => /^(?:Caption|Note|FENote|Reference)$/u.test(role)) &&
    Math.max(item.width, item.height) <= item.fontSize * 14 &&
    Math.min(item.width, item.height) <= item.fontSize * 2.5
  );
}

function centerInside(item: SourceText, rect: Rect): boolean {
  const x = item.x + item.width / 2,
    y = item.y + item.height / 2;
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}

/** Read only the initial figure edge, so adjacent labels cannot grow through surrounding prose. */
export function adjacentFigureLabels(items: SourceText[], rect: Rect): SourceText[] {
  if (!finiteRect(rect)) return [];
  const inside = items.filter((item) => compactLabel(item) && centerInside(item, rect));
  if (inside.length < 3) return [];
  const fonts = new Map<string, number[]>();
  for (const item of inside) {
    const sizes = fonts.get(item.fontName) ?? [];
    sizes.push(item.fontSize);
    fonts.set(item.fontName, sizes);
  }
  return items.filter((item) => {
    if (!compactLabel(item) || centerInside(item, rect)) return false;
    const sizes = fonts.get(item.fontName);
    if (!sizes || sizes.length < 2) return false;
    const ordered = [...sizes].sort((a, b) => a - b),
      typical = ordered[Math.floor(ordered.length / 2)];
    if (item.fontSize < typical * 0.8 || item.fontSize > typical * 1.2) return false;
    if (
      Math.min(rect.width, rect.height) < item.fontSize * 6 ||
      Math.max(rect.width, rect.height) < item.fontSize * 12
    )
      return false;
    const centerX = item.x + item.width / 2,
      centerY = item.y + item.height / 2,
      edge = item.fontSize * 1.5;
    const beside =
      centerY >= rect.y &&
      centerY <= rect.y + rect.height &&
      ((centerX < rect.x && item.x + item.width >= rect.x - edge) ||
        (centerX > rect.x + rect.width && item.x <= rect.x + rect.width + edge));
    const aboveBelow =
      centerX >= rect.x &&
      centerX <= rect.x + rect.width &&
      ((centerY < rect.y && item.y + item.height >= rect.y - edge) ||
        (centerY > rect.y + rect.height && item.y <= rect.y + rect.height + edge));
    if (!beside && !aboveBelow) return false;
    const corridor = union([
      item,
      {
        x: Math.max(rect.x, Math.min(rect.x + rect.width, centerX)),
        y: Math.max(rect.y, Math.min(rect.y + rect.height, centerY)),
        width: 0,
        height: 0,
      },
    ]);
    return !items.some(
      (other) =>
        other !== item &&
        !centerInside(other, rect) &&
        !compactLabel(other) &&
        intersects(corridor, other),
    );
  });
}
