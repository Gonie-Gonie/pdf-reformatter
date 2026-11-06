import { finiteRect, intersects, union } from '../../core/geometry';
import type { Rect, SourcePage, SourceText } from '../../core/model';
import { intersection, multiply, transformedBox } from './graphic-objects';

interface VisibilityOperators {
  save: number;
  restore: number;
  transform: number;
  paintFormXObjectBegin: number;
  paintFormXObjectEnd: number;
  beginGroup: number;
  endGroup: number;
  setFont: number;
  setTextRenderingMode: number;
  setFillGray: number;
  setFillRGBColor: number;
  showText: number;
  showSpacedText: number;
  nextLineShowText: number;
  nextLineSetSpacingShowText: number;
}
interface Paint {
  clip?: Rect;
  white: boolean;
}
interface State {
  matrix: number[];
  clip?: Rect;
  font: string;
  mode: number;
  white: boolean;
}
function numbers(value: unknown, length: number): number[] | undefined {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) return;
  const result = Array.from(value as ArrayLike<number>);
  return result.length === length && result.every(Number.isFinite) ? result : undefined;
}

/** Restrict fonts used inside embedded PDF pages to their actual painted Form clips. */
export function visibleTextItems(
  items: SourceText[],
  list: { fnArray: readonly number[]; argsArray: readonly unknown[] },
  ops: VisibilityOperators,
  viewport: readonly number[],
  page: Pick<SourcePage, 'width' | 'height'>,
  raster: { pixels: Uint8ClampedArray; width: number; height: number; scale: number },
): SourceText[] {
  let state: State = { matrix: [1, 0, 0, 1, 0, 0], font: '', mode: 0, white: false };
  const stack: State[] = [];
  const fonts = new Map<string, Paint[]>();
  const save = () => stack.push({ ...state, matrix: [...state.matrix] });
  const restore = () => {
    state = stack.pop() ?? state;
  };
  const clip = (box: number[], matrix: number[]) => {
    const bounds = transformedBox(box, multiply(viewport, matrix));
    state.clip = intersection(
      bounds,
      state.clip ?? { x: 0, y: 0, width: page.width, height: page.height },
    );
  };
  for (let index = 0; index < list.fnArray.length; index++) {
    const operation = list.fnArray[index],
      value = list.argsArray[index];
    const args: unknown[] = Array.isArray(value) ? value : [];
    if (operation === ops.save) save();
    else if ([ops.restore, ops.paintFormXObjectEnd, ops.endGroup].includes(operation)) restore();
    else if (operation === ops.transform) {
      const matrix = numbers(args, 6);
      if (matrix) state.matrix = multiply(state.matrix, matrix);
    } else if (operation === ops.paintFormXObjectBegin) {
      save();
      const matrix = numbers(args[0], 6),
        box = numbers(args[1], 4);
      if (matrix) state.matrix = multiply(state.matrix, matrix);
      if (box) clip(box, state.matrix);
    } else if (operation === ops.beginGroup) {
      save();
      const group = args[0] as { matrix?: unknown; bbox?: unknown } | undefined;
      const matrix = numbers(group?.matrix, 6),
        box = numbers(group?.bbox, 4);
      if (box) clip(box, matrix ? multiply(state.matrix, matrix) : state.matrix);
    } else if (operation === ops.setFont && typeof args[0] === 'string') state.font = args[0];
    else if (operation === ops.setTextRenderingMode && typeof args[0] === 'number')
      state.mode = args[0];
    else if (operation === ops.setFillGray) state.white = args[0] === 1;
    else if (operation === ops.setFillRGBColor)
      state.white =
        args[0] === '#ffffff' || (args.length === 3 && args.every((channel) => channel === 255));
    else if (
      [
        ops.showText,
        ops.showSpacedText,
        ops.nextLineShowText,
        ops.nextLineSetSpacingShowText,
      ].includes(operation) &&
      state.font
    ) {
      const paints = fonts.get(state.font) ?? [];
      fonts.set(state.font, paints);
      if ((state.mode & 3) === 3) continue;
      if (
        !paints.some(
          (paint) =>
            paint.white === state.white &&
            JSON.stringify(paint.clip) === JSON.stringify(state.clip),
        )
      )
        paints.push({ clip: state.clip, white: state.white });
    }
  }
  const hasInk = (item: SourceText): boolean => {
    const { pixels, width, height, scale } = raster;
    const padding = Math.max(1, item.fontSize * 0.15);
    const left = Math.max(0, Math.floor((item.x - padding) * scale));
    const right = Math.min(width, Math.ceil((item.x + item.width + padding) * scale));
    const top = Math.max(0, Math.floor((item.y - padding) * scale));
    const bottom = Math.min(height, Math.ceil((item.y + item.height + padding) * scale));
    for (let y = top; y < bottom; y++)
      for (let x = left; x < right; x++) {
        const offset = (y * width + x) * 4;
        if (
          pixels[offset + 3] > 50 &&
          Math.min(pixels[offset], pixels[offset + 1], pixels[offset + 2]) < 245
        )
          return true;
      }
    return false;
  };
  return items.flatMap((item) => {
    const font = item.fontName.trim().split(/\s+/u).at(-1)!;
    const paints = fonts.get(font);
    if (!paints) return [item];
    const candidates = paints.filter((paint) => !paint.clip || intersects(paint.clip, item));
    if (!candidates.length) return [];
    if (candidates.every((paint) => paint.white))
      return hasInk(item) ? [{ ...item, preserve: true }] : [];
    if (candidates.some((paint) => !paint.clip)) return [item];
    // Combining marks can have no advance width. Their vertical clip is still
    // meaningful, and they must remain available to the base glyph's math crop.
    if (item.width === 0 && item.height > 0) {
      const visible = union(candidates.map((paint) => intersection(paint.clip!, item)));
      if (visible.height <= 0) return [];
      return [{ ...item, y: visible.y, height: visible.height }];
    }
    const visible = union(
      candidates.map((paint) => intersection(paint.clip!, item)).filter(finiteRect),
    );
    if (!finiteRect(visible)) return [];
    if (visible.width < item.width - 0.5 || visible.height < item.height - 0.5)
      return [{ ...item, ...visible, preserve: true }];
    return [item];
  });
}
