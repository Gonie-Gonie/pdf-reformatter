import type { Rect } from './model';

export function contentWidth(
  pageWidthPt: number,
  leftMarginPt: number,
  rightMarginPt: number,
): number {
  if (
    ![pageWidthPt, leftMarginPt, rightMarginPt].every(Number.isFinite) ||
    pageWidthPt <= 0 ||
    leftMarginPt < 0 ||
    rightMarginPt < 0
  ) {
    throw new RangeError('페이지와 여백에는 유효한 양수를 입력하세요.');
  }
  const width = pageWidthPt - leftMarginPt - rightMarginPt;
  if (width <= 0) throw new RangeError('여백이 본문 폭보다 큽니다.');
  return width;
}

export function intersects(a: Rect, b: Rect, tolerance = 0): boolean {
  return (
    a.x < b.x + b.width + tolerance &&
    a.x + a.width + tolerance > b.x &&
    a.y < b.y + b.height + tolerance &&
    a.y + a.height + tolerance > b.y
  );
}

export function union(rects: Rect[]): Rect {
  if (!rects.length) return { x: 0, y: 0, width: 0, height: 0 };
  const x = Math.min(...rects.map((rect) => rect.x));
  const y = Math.min(...rects.map((rect) => rect.y));
  return {
    x,
    y,
    width: Math.max(...rects.map((rect) => rect.x + rect.width)) - x,
    height: Math.max(...rects.map((rect) => rect.y + rect.height)) - y,
  };
}

export function finiteRect(rect: Rect): boolean {
  return (
    [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) &&
    rect.width > 0 &&
    rect.height > 0
  );
}

export function clampRect(rect: Rect, width: number, height: number): Rect {
  const x = Math.max(0, Math.min(width, rect.x));
  const y = Math.max(0, Math.min(height, rect.y));
  return {
    x,
    y,
    width: Math.max(0, Math.min(width, rect.x + rect.width) - x),
    height: Math.max(0, Math.min(height, rect.y + rect.height) - y),
  };
}
