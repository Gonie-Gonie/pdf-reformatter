import { clampRect, finiteRect, intersects, union } from '../../core/geometry';
import type { Rect, SourcePage } from '../../core/model';
import { captionBounds, separatelyCaptioned } from './graphics';

interface GraphicOperators {
  save: number;
  restore: number;
  transform: number;
  paintFormXObjectBegin: number;
  paintFormXObjectEnd: number;
  beginGroup: number;
  endGroup: number;
  paintImageXObject: number;
  paintInlineImageXObject: number;
}

function numbers(value: unknown, length: number): number[] | undefined {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) return;
  const result = Array.from(value as ArrayLike<number>);
  return result.length === length && result.every(Number.isFinite) ? result : undefined;
}

export function multiply(a: readonly number[], b: readonly number[]): number[] {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

export function transformedBox(box: readonly number[], matrix: readonly number[]): Rect {
  const corners = [
    [box[0], box[1]],
    [box[2], box[1]],
    [box[0], box[3]],
    [box[2], box[3]],
  ].map(([x, y]) => ({
    x: matrix[0] * x + matrix[2] * y + matrix[4],
    y: matrix[1] * x + matrix[3] * y + matrix[5],
    width: 0,
    height: 0,
  }));
  return union(corners);
}

export function intersection(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x),
    y = Math.max(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y),
  };
}

/** Keep the PDF author's object boundaries even when its visible ink is disconnected. */
export function graphicObjectBounds(
  list: { fnArray: readonly number[]; argsArray: readonly unknown[] },
  operators: GraphicOperators,
  viewport: readonly number[],
  page: { width: number; height: number },
): Rect[] {
  if (!numbers(viewport, 6)) return [];
  let matrix = [1, 0, 0, 1, 0, 0];
  let clip: Rect = { x: 0, y: 0, width: page.width, height: page.height };
  const stack: { matrix: number[]; clip: Rect }[] = [];
  const result: Rect[] = [];
  const save = () => stack.push({ matrix: [...matrix], clip: { ...clip } });
  const restore = () => {
    const previous = stack.pop();
    if (previous) ({ matrix, clip } = previous);
  };
  const boundary = (box: number[], transform = matrix) => {
    const rect = intersection(transformedBox(box, multiply(viewport, transform)), clip);
    if (finiteRect(rect)) result.push(rect);
    return rect;
  };
  for (let index = 0; index < list.fnArray.length; index++) {
    const operation = list.fnArray[index];
    const value = list.argsArray[index];
    const args: unknown[] = Array.isArray(value) ? value : [];
    if (operation === operators.save) save();
    else if (
      operation === operators.restore ||
      operation === operators.paintFormXObjectEnd ||
      operation === operators.endGroup
    )
      restore();
    else if (operation === operators.transform) {
      const transform = numbers(args, 6);
      if (transform) matrix = multiply(matrix, transform);
    } else if (operation === operators.paintFormXObjectBegin) {
      save();
      const transform = numbers(args[0], 6),
        box = numbers(args[1], 4);
      if (transform) matrix = multiply(matrix, transform);
      if (box) clip = boundary(box);
    } else if (operation === operators.beginGroup) {
      save();
      const group = args[0] as { matrix?: unknown; bbox?: unknown } | undefined;
      const transform = numbers(group?.matrix, 6),
        box = numbers(group?.bbox, 4);
      // The following FormBegin applies the matrix; the group only adds its clip.
      if (box) clip = boundary(box, transform ? multiply(matrix, transform) : matrix);
    } else if (
      operation === operators.paintImageXObject ||
      operation === operators.paintInlineImageXObject
    )
      boundary([0, 0, 1, 1]);
  }
  return result;
}

/** Object evidence may join a chart and legend, but never an encompassing prose/page wrapper. */
export function joinGraphicObjects(regions: Rect[], objects: Rect[], source: SourcePage): Rect[] {
  const result = regions.map((rect) => ({ ...rect }));
  const captions = captionBounds(source);
  for (const object of [...objects].sort((a, b) => a.width * a.height - b.width * b.height)) {
    if (
      !finiteRect(object) ||
      object.width < 24 ||
      object.height < 24 ||
      object.width * object.height > source.width * source.height * 0.7 ||
      (object.width >= source.width * 0.85 && object.height >= source.height * 0.65)
    )
      continue;
    const contained = result.filter(
      (rect) =>
        rect.x >= object.x - 3 &&
        rect.y >= object.y - 3 &&
        rect.x + rect.width <= object.x + object.width + 3 &&
        rect.y + rect.height <= object.y + object.height + 3,
    );
    if (contained.length < 2) continue;
    if (
      contained.some((one, index) =>
        contained.slice(index + 1).some((other) => separatelyCaptioned(one, other, captions)),
      )
    )
      continue;
    // Partial overlaps can belong to a neighboring illustration or a clipped wrapper.
    if (result.some((rect) => !contained.includes(rect) && intersects(rect, object))) continue;
    const items = source.items.filter((item) => {
      const x = item.x + item.width / 2,
        y = item.y + item.height / 2;
      return (
        x >= object.x &&
        x <= object.x + object.width &&
        y >= object.y &&
        y <= object.y + object.height
      );
    });
    // A prose wrapper can emit each ordinary word as a separate PDF text run.
    const rows: { baseline: number; size: number; items: typeof items }[] = [];
    for (const item of items) {
      const baseline = item.baselineY ?? item.y + item.fontSize * 0.8;
      const row = rows.find(
        (entry) => Math.abs(entry.baseline - baseline) <= Math.min(entry.size, item.fontSize) * 0.4,
      );
      if (row) row.items.push(item);
      else rows.push({ baseline, size: item.fontSize, items: [item] });
    }
    const values = rows.map((row) =>
      row.items
        .sort((a, b) => a.x - b.x)
        .map((item) => item.text.trim())
        .join(' '),
    );
    const caption = /^(?:fig(?:ure)?\.?|table|그림|표)\s*[\dIVX]/iu;
    if (values.some((value) => caption.test(value))) continue;
    const prose = values.map((value) => value.match(/\p{L}{3,}/gu)?.length ?? 0);
    if (prose.filter((words) => words >= 6).length >= 2 || prose.some((words) => words >= 12))
      continue;
    const combined = clampRect(union([object, ...contained]), source.width, source.height);
    for (let index = result.length - 1; index >= 0; index--)
      if (contained.includes(result[index])) result.splice(index, 1);
    result.push(combined);
  }
  return result;
}
