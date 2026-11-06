import { clampRect, finiteRect, intersects, union } from './geometry';
import type { Rect, SourcePage, SourceText } from './model';
import type { PreservationRegion } from './preservation';

interface StructuralLine {
  items: SourceText[];
  rect: Rect;
  text: string;
  fontSize: number;
}

interface Delimiter {
  item: SourceText;
  family: number;
  side: 'left' | 'right';
  part: 'top' | 'middle' | 'bottom' | 'whole';
}

interface Frame {
  items: SourceText[];
  rect: Rect;
  size: number;
}

// Unicode mathematical extensions and Adobe Symbol's established private-use
// equivalents describe complete delimiters even when PDF text runs do not.
const extensions = [
  ['\u239b', '\u239c', '\u239d', '\u239e', '\u239f', '\u23a0'],
  ['\u23a1', '\u23a2', '\u23a3', '\u23a4', '\u23a5', '\u23a6'],
  ['\u23a7', '\u23a8\u23aa', '\u23a9', '\u23ab', '\u23ac\u23aa', '\u23ad'],
  ['\uf8eb', '\uf8ec', '\uf8ed', '\uf8f6', '\uf8f7', '\uf8f8'],
  ['\uf8ee', '\uf8ef', '\uf8f0', '\uf8f9', '\uf8fa', '\uf8fb'],
  ['\uf8f1', '\uf8f2\uf8f4', '\uf8f3', '\uf8fc', '\uf8fd\uf8f4', '\uf8fe'],
];

function delimiter(item: SourceText, bodySize: number): Delimiter | undefined {
  const value = item.text.trim();
  if ([...value].length !== 1) return undefined;
  for (let family = 0; family < extensions.length; family++) {
    const index = extensions[family].findIndex((characters) => characters.includes(value));
    if (index >= 0)
      return {
        item,
        family: family % 3,
        side: index < 3 ? 'left' : 'right',
        part: (['top', 'middle', 'bottom'] as const)[index % 3],
      };
  }
  if (item.height < bodySize * 1.8) return undefined;
  const whole = ['(', ')', '[', ']', '{', '}'].indexOf(value);
  return whole < 0
    ? undefined
    : {
        item,
        family: Math.floor(whole / 2),
        side: whole % 2 ? 'right' : 'left',
        part: 'whole',
      };
}

function stacks(
  delimiters: Delimiter[],
): { delimiter: Delimiter; items: SourceText[]; rect: Rect }[] {
  return delimiters.flatMap((seed) => {
    if (seed.part !== 'top' && seed.part !== 'whole') return [];
    if (seed.part === 'whole') return [{ delimiter: seed, items: [seed.item], rect: seed.item }];
    const column = delimiters
      .filter(
        (entry) =>
          entry.family === seed.family &&
          entry.side === seed.side &&
          Math.abs(entry.item.x - seed.item.x) <= seed.item.fontSize * 0.4 &&
          entry.item.y >= seed.item.y &&
          entry.item.y - seed.item.y <= seed.item.fontSize * 30,
      )
      .sort((a, b) => a.item.y - b.item.y);
    const bottom = column.find(
      (entry) => entry.part === 'bottom' && entry.item.y > seed.item.y + seed.item.fontSize * 0.5,
    );
    if (!bottom) return [];
    const members = column.filter((entry) => entry.item.y <= bottom.item.y);
    if (members.some((entry) => entry !== seed && entry.part === 'top')) return [];
    if (
      members.some((entry, index) => {
        const previous = members[index - 1];
        return (
          previous && entry.item.y - previous.item.y - previous.item.height > seed.item.fontSize
        );
      })
    )
      return [];
    const items = members.map((entry) => entry.item);
    return [{ delimiter: seed, items, rect: union(items) }];
  });
}

function shortMath(item: SourceText): boolean {
  const value = item.text.trim();
  if (
    !value ||
    value.length > 30 ||
    /\p{L}{3,}/u.test(value.replace(/\b(?:sin|cos|tan|log|exp|lim)\b/gu, ''))
  )
    return false;
  return (
    !item.artifact &&
    !item.structureRoles?.some((role) => /^(?:Caption|Note|Reference)$/u.test(role))
  );
}

function cellRows(items: SourceText[], size: number): number {
  const rows: number[] = [];
  for (const item of items.filter((entry) => entry.fontSize >= size * 0.75)) {
    const baseline = item.baselineY ?? item.y + item.height / 2;
    if (!rows.some((row) => Math.abs(row - baseline) <= size * 0.4)) rows.push(baseline);
  }
  return rows.length;
}

function proseInside(lines: readonly StructuralLine[], rect: Rect): boolean {
  return lines.some(
    (line) =>
      intersects(line.rect, rect) &&
      line.rect.y + line.rect.height / 2 >= rect.y &&
      line.rect.y + line.rect.height / 2 <= rect.y + rect.height &&
      (line.text.match(/\p{L}{4,}/gu)?.length ?? 0) >= 3 &&
      (line.text.match(/\p{L}/gu)?.length ?? 0) >= 20,
  );
}

/** Recover untagged, multi-row matrices from paired complete tall delimiters. */
export function matrixRegions(
  page: SourcePage,
  lines: readonly StructuralLine[],
): PreservationRegion[] {
  if (!finiteRect({ x: 0, y: 0, width: page.width, height: page.height })) return [];
  const items = page.items.filter(
    (item) => finiteRect(item) && item.fontSize > 0 && !item.artifact,
  );
  const sizes = items.map((item) => item.fontSize).sort((a, b) => a - b);
  const bodySize = sizes[Math.floor(sizes.length / 2)] ?? 12;
  const delimiters = items.flatMap((item) => {
    const token = delimiter(item, bodySize);
    return token ? [token] : [];
  });
  const delimiterIds = new Set(delimiters.map((entry) => entry.item.id));
  const columns = stacks(delimiters);
  const frames: Frame[] = [];
  for (const left of columns.filter((column) => column.delimiter.side === 'left')) {
    const size = left.delimiter.part === 'whole' ? bodySize : left.delimiter.item.fontSize;
    const right = columns
      .filter(
        (candidate) =>
          candidate.delimiter.side === 'right' &&
          candidate.delimiter.family === left.delimiter.family &&
          candidate.rect.x > left.rect.x + left.rect.width * 0.5 &&
          candidate.rect.x - left.rect.x < page.width * 0.75 &&
          Math.abs(candidate.rect.y - left.rect.y) <= size * 0.6 &&
          Math.abs(candidate.rect.height - left.rect.height) <= size,
      )
      .sort((a, b) => a.rect.x - b.rect.x)[0];
    if (!right) continue;
    const bracketRect = union([left.rect, right.rect]);
    if (bracketRect.height < size * 1.8) continue;
    const cells = items.filter((item) => {
      const centerX = item.x + item.width / 2;
      const centerY = item.y + item.height / 2;
      return (
        !delimiterIds.has(item.id) &&
        centerX > left.rect.x + left.rect.width * 0.5 &&
        centerX < right.rect.x + right.rect.width * 0.5 &&
        centerY >= bracketRect.y - size * 0.4 &&
        centerY <= bracketRect.y + bracketRect.height + size * 0.75
      );
    });
    if (!cells.length || cells.some((item) => !shortMath(item)) || cellRows(cells, bodySize) < 2)
      continue;
    const members = [...left.items, ...cells, ...right.items];
    const rect = union(members);
    if (rect.height > page.height * 0.5 || proseInside(lines, rect)) continue;
    frames.push({ items: members, rect, size: bodySize });
  }
  const owned = new Set(frames.flatMap((frame) => frame.items.map((item) => item.id)));
  const groups: Frame[] = [];
  for (const frame of frames.sort((a, b) =>
    Math.abs(a.rect.y - b.rect.y) <= bodySize * 0.6 ? a.rect.x - b.rect.x : a.rect.y - b.rect.y,
  )) {
    const previous = groups.at(-1);
    const gap = previous ? frame.rect.x - previous.rect.x - previous.rect.width : Infinity;
    const between = previous
      ? items.filter(
          (item) =>
            item.x >= previous.rect.x + previous.rect.width &&
            item.x + item.width <= frame.rect.x &&
            item.y + item.height / 2 >= Math.max(previous.rect.y, frame.rect.y) &&
            item.y + item.height / 2 <=
              Math.min(previous.rect.y + previous.rect.height, frame.rect.y + frame.rect.height),
        )
      : [];
    if (
      previous &&
      Math.abs(frame.rect.y - previous.rect.y) <= bodySize * 0.6 &&
      Math.abs(frame.rect.height - previous.rect.height) <= bodySize &&
      gap >= 0 &&
      gap <= bodySize * 8 &&
      (gap <= bodySize * 2.5 || between.length > 0) &&
      between.every(shortMath) &&
      !proseInside(lines, union([previous.rect, frame.rect]))
    ) {
      previous.items.push(...between, ...frame.items);
      previous.rect = union([previous.rect, frame.rect, ...between]);
    } else groups.push({ ...frame, items: [...frame.items] });
  }
  for (const group of groups) {
    const included = new Set(group.items.map((item) => item.id));
    const top = group.rect.y;
    const bottom = group.rect.y + group.rect.height;
    let changed = true;
    while (changed) {
      changed = false;
      for (const item of items) {
        if (included.has(item.id) || owned.has(item.id) || !shortMath(item)) continue;
        const centerY = item.y + item.height / 2;
        const gap = Math.max(
          group.rect.x - item.x - item.width,
          item.x - group.rect.x - group.rect.width,
          0,
        );
        if (centerY < top || centerY > bottom || gap > bodySize * 1.5) continue;
        included.add(item.id);
        group.items.push(item);
        group.rect = union([group.rect, item]);
        changed = true;
      }
    }
  }
  return groups.map((group) => ({
    rect: clampRect(
      {
        x: group.rect.x - 2,
        y: group.rect.y - 2,
        width: group.rect.width + 4,
        height: group.rect.height + 4,
      },
      page.width,
      page.height,
    ),
    reason: '행렬·벡터와 인접 수식을 원문 모양으로 보존',
    displayMath: true,
  }));
}
