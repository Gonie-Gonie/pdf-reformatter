import { clampRect, intersects, union } from './geometry';
import type { Rect, SourcePage, SourceText } from './model';

interface InlineLine {
  items: SourceText[];
  rect: Rect;
  text: string;
  fontSize: number;
}

export interface InlineMathAtom {
  rect: Rect;
  sourceIds: string[];
  /** UTF-16 offsets inside the original source item, including partial edge runs. */
  spans: { sourceId: string; start: number; end: number }[];
  fontSize: number;
  baselineY: number;
}

interface Row {
  rect: Rect;
  baseline: number;
  size: number;
  items: SourceText[];
  continuation?: boolean;
}

interface Piece {
  item: SourceText;
  start: number;
  end: number;
  rect: Rect;
  strong: boolean;
  row: Row;
}

const math =
  /[\u0000-\u0008\u000b\u000e-\u001f\ufffd\p{Sm}\p{Script=Greek}\u2070-\u209f\u20d0-\u20ff·⇌↔⇒⇔²³¹¼]/u;
const mathFont = /math|symbol|cmsy|cmmi|cmex|msam|msbm/iu;
const excludedRole =
  /^(?:H[1-6]|Figure|Caption|Table|TR|TD|TH|Note|FENote|Reference|TOC|TOCI|Index)$/u;
const compact =
  /^[\u0000-\u0008\u000b\u000e-\u001f\ufffd\p{Sm}\p{L}\p{N}\p{Mark}_()[\]{},.:;!%/·°◦⇌↔⇒⇔-]{1,20}$/u;

function position(item: SourceText): number {
  return item.baselineY ?? item.y + item.fontSize * 0.8;
}

function proseRows(lines: readonly InlineLine[], excluded: ReadonlySet<string>): Row[] {
  const allowed = (item: SourceText) =>
    !excluded.has(item.id) &&
    !item.artifact &&
    !item.preserve &&
    !item.structureRoles?.some((role) => excludedRole.test(role));
  const rows = lines.flatMap((line): Row[] => {
    const items = line.items.filter(allowed);
    const sizes = items.map((item) => item.fontSize).sort((a, b) => a - b);
    const ordinarySize = sizes[Math.floor(sizes.length / 2)] ?? line.fontSize;
    const prose = items.filter(
      (item) =>
        item.fontSize >= ordinarySize * 0.85 &&
        (item.text.match(/\p{L}/gu)?.length ?? 0) >= 8 &&
        /\s/u.test(item.text) &&
        ((item.text.match(/\p{Ll}{3,}/gu)?.length ?? 0) >= 3 ||
          /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(item.text)) &&
        !mathFont.test(item.fontName),
    );
    const words = items.filter(
      (item) =>
        item.fontSize >= ordinarySize * 0.85 &&
        !mathFont.test(item.fontName) &&
        !math.test(item.text) &&
        /\p{Ll}{3,}/u.test(item.text) &&
        !/^(?:min|max|sin|cos|tan|log|ln|exp|lim|argmin|argmax)$/u.test(item.text.trim()),
    );
    const wordCount = words.flatMap((item) => item.text.match(/\p{Ll}{3,}/gu) ?? []).length;
    const wordLetters = words.reduce(
      (sum, item) => sum + (item.text.match(/\p{L}/gu)?.length ?? 0),
      0,
    );
    const equalsDefinitions = items.filter(
      (item) =>
        item.fontSize >= ordinarySize * 0.85 &&
        !mathFont.test(item.fontName) &&
        /^=\s+\p{L}/u.test(item.text.trim()) &&
        (item.text.match(/\p{Ll}{3,}/gu)?.length ?? 0) >= 2 &&
        (item.text.match(/\p{L}/gu)?.length ?? 0) >= 12,
    );
    // Inline definitions may contain only two ordinary words between long
    // mathematical expressions, e.g. "The conditional variance ... is".
    const shortDefinition =
      (wordCount >= 2 &&
        wordLetters >= 12 &&
        items.some((item) => /^(?:the|a|an|is|are|was|were)$/iu.test(item.text.trim()))) ||
      equalsDefinitions.length > 0;
    if (!prose.length && !shortDefinition && (wordCount < 3 || wordLetters < 12)) return [];
    let anchor = [...(prose.length ? prose : words.length ? words : equalsDefinitions)].sort(
      (a, b) => b.text.length - a.text.length,
    )[0];
    const larger = items
      .filter(
        (item) =>
          /\p{L}/u.test(item.text) &&
          !math.test(item.text) &&
          item.fontSize > anchor.fontSize * 1.15 &&
          item.fontSize < anchor.fontSize * 1.7,
      )
      .sort((a, b) => b.fontSize - a.fontSize)[0];
    if (larger) anchor = larger;
    return [{ rect: union(items), baseline: position(anchor), size: anchor.fontSize, items }];
  });
  const proseIds = new Set(rows.flatMap((row) => row.items.map((item) => item.id)));
  // A short mathematical tail can wrap to the next ordinary prose baseline.
  // A colon, extra vertical space, or a tall fraction still identifies display math.
  const continuations: Row[] = [];
  for (const line of lines) {
    const items = line.items.filter(allowed);
    if (!items.length || items.some((item) => proseIds.has(item.id))) continue;
    const value = items
      .map((item) => item.text)
      .join('')
      .trim();
    if (
      !value ||
      /^[()[\]{}.,;:]+$/u.test(value) ||
      value.replace(/\s/gu, '').length > 20 ||
      items.some((item) => /\p{L}{4,}/u.test(item.text))
    )
      continue;
    const anchor = [...items].sort((a, b) => b.fontSize - a.fontSize)[0];
    const baseline = position(anchor);
    const previous = rows
      .filter(
        (row) =>
          baseline - row.baseline >= row.size * 0.9 &&
          baseline - row.baseline <= row.size * 1.7 &&
          Math.abs(line.rect.x - row.rect.x) <= row.size * 1.2,
      )
      .sort((a, b) => b.baseline - a.baseline)[0];
    if (!previous) continue;
    const ordinary = [...previous.items].sort((a, b) => b.text.length - a.text.length)[0];
    const previousText = previous.items
      .map((item) => item.text)
      .join('')
      .trim();
    const columnWidth = Math.max(
      ...rows
        .filter((row) => Math.abs(row.rect.x - previous.rect.x) <= previous.size * 1.2)
        .map((row) => row.rect.width),
    );
    if (
      /[.!?:;]$/u.test(previousText) ||
      previous.rect.width < columnWidth * 0.7 ||
      line.rect.width > previous.rect.width * 0.3 ||
      items.some(
        (item) => item.fontSize > previous.size * 1.15 || item.height > previous.size * 1.9,
      ) ||
      Math.max(...items.map(position)) - Math.min(...items.map(position)) > previous.size * 0.45 ||
      !items.some(
        (item) =>
          math.test(item.text) ||
          /[=+*/]/u.test(item.text) ||
          mathFont.test(item.fontName) ||
          item.fontName !== ordinary.fontName ||
          item.fontSize < previous.size * 0.86,
      )
    )
      continue;
    continuations.push({
      rect: line.rect,
      baseline,
      size: previous.size,
      items,
      continuation: true,
    });
  }
  return [...rows, ...continuations];
}

function nearRow(item: SourceText, rows: readonly Row[]): Row | undefined {
  const uncertain =
    /^[\u0000-\u0008\u000b\u000e-\u001f\ufffd()[\]{}]+$/u.test(item.text) ||
    (item.width === 0 && /^\p{Mark}+$/u.test(item.text));
  const candidates = rows
    .filter((row) => {
      const center = item.x + item.width / 2;
      const offset = Math.abs(position(item) - row.baseline);
      const shiftedMathDelimiter =
        uncertain &&
        offset <= row.size * 1.8 &&
        row.items.some(
          (neighbor) =>
            neighbor !== item &&
            math.test(neighbor.text) &&
            Math.max(item.x - neighbor.x - neighbor.width, neighbor.x - item.x - item.width, 0) <=
              row.size,
        );
      return (
        center >= row.rect.x - row.size &&
        center <= row.rect.x + row.rect.width + row.size &&
        (offset <= row.size * 0.9 || shiftedMathDelimiter) &&
        item.fontSize <= row.size * 1.6
      );
    })
    .sort((a, b) => Math.abs(position(item) - a.baseline) - Math.abs(position(item) - b.baseline));
  const nearest = candidates[0];
  if (!nearest || !uncertain || Math.abs(position(item) - nearest.baseline) <= nearest.size * 0.35)
    return nearest;
  const support = (row: Row): number => {
    let left = false,
      right = false;
    for (const neighbor of row.items) {
      if (neighbor === item || Math.abs(position(neighbor) - row.baseline) > row.size * 0.4)
        continue;
      const before = item.x - neighbor.x - neighbor.width;
      const after = neighbor.x - item.x - item.width;
      if (before >= -row.size * 0.15 && before <= row.size * 0.6) left = true;
      if (after >= -row.size * 0.15 && after <= row.size * 0.6) right = true;
    }
    return Number(left) + Number(right);
  };
  return candidates.sort((a, b) => support(b) - support(a))[0];
}

function weight(text: string): number {
  return [...text].reduce(
    (sum, char) =>
      sum +
      (/[ilIjtfr.,:;'!|()[\]{}]/u.test(char)
        ? 0.3
        : /[mwMW@%]/u.test(char)
          ? 0.85
          : /\s/u.test(char)
            ? 0.27
            : /[A-Z\p{Script=Greek}]/u.test(char)
              ? 0.66
              : 0.5),
    0,
  );
}

function sliceRect(item: SourceText, start: number, end: number, row: Row): Rect {
  const total = weight(item.text);
  const left = total ? weight(item.text.slice(0, start)) / total : 0;
  const right = total ? weight(item.text.slice(0, end)) / total : 1;
  const baseline = position(item);
  const accent = item.width === 0 && /^\p{Mark}+$/u.test(item.text.slice(start, end).trim());
  const tall =
    !accent &&
    (/[∑∏∫√\p{Mark}\u0000-\u0008\u000b\u000e-\u001f\ufffd]/u.test(item.text.slice(start, end)) ||
      item.height > item.fontSize * 2);
  const top = accent
    ? Math.min(item.y, baseline - item.fontSize * 1.1)
    : tall
      ? item.y
      : Math.max(item.y, baseline - item.fontSize * 0.82);
  const bottom = tall
    ? item.y + item.height
    : Math.min(item.y + item.height, baseline + item.fontSize * 0.25);
  const shiftedBracket =
    row.baseline - baseline > row.size * 0.4 &&
    (/^[\u0000-\u0008\u000b\u000e-\u001f\ufffd()[\]{}]+$/u.test(item.text.slice(start, end)) ||
      (item.width === 0 && /^\p{Mark}+$/u.test(item.text)));
  return {
    x: item.x + item.width * left,
    y: shiftedBracket ? row.baseline - row.size * 0.98 : top,
    width: item.width * (right - left),
    height: shiftedBracket ? row.size * 1.33 : bottom - top,
  };
}

function gap(a: Rect, b: Rect): number {
  return Math.max(a.x - b.x - b.width, b.x - a.x - a.width, 0);
}

/** Local math objects remain inline; source prose around them can still reflow. */
export function inlineMathAtoms(
  page: SourcePage,
  lines: readonly InlineLine[],
  excludedIds: ReadonlySet<string> = new Set(),
  referenceIds: ReadonlySet<string> = new Set(),
): InlineMathAtom[] {
  const blocked = new Set([...excludedIds, ...referenceIds]);
  const valid = page.items.filter(
    (item) =>
      !blocked.has(item.id) &&
      !item.artifact &&
      !item.preserve &&
      !item.structureRoles?.some((role) => excludedRole.test(role)) &&
      [item.x, item.y, item.width, item.height, item.fontSize].every(Number.isFinite) &&
      item.width >= 0 &&
      item.height > 0 &&
      item.fontSize > 0 &&
      item.text.trim(),
  );
  const rows = proseRows(lines, blocked);
  const bodyFonts = new Map<string, number>();
  for (const row of rows)
    for (const item of row.items)
      if (item.text.trim().length > 8)
        bodyFonts.set(item.fontName, (bodyFonts.get(item.fontName) ?? 0) + item.text.length);
  const ordinaryFont = [...bodyFonts].sort((a, b) => b[1] - a[1])[0]?.[0];
  const pieces: Piece[] = [];
  const add = (item: SourceText, start: number, end: number, row: Row, strong: boolean) => {
    if (
      start >= end ||
      pieces.some((piece) => piece.item === item && piece.start === start && piece.end === end)
    )
      return;
    const rect = sliceRect(item, start, end, row);
    if (/^[\u0000-\u0008\u000b\u000e-\u001f\ufffd]$/u.test(item.text.slice(start, end))) {
      // A missing Unicode mapping may report the .notdef advance (often .25em)
      // although the painted operator is much wider. Keep its complete ink in
      // the available whitespace, stopping before the following source run.
      const next = row.items.filter(
        (neighbor) =>
          neighbor !== item &&
          neighbor.x >= item.x + item.width - 0.05 &&
          Math.abs(position(neighbor) - row.baseline) <= row.size * 0.45,
      );
      const right = Math.min(
        rect.x + Math.max(rect.width, row.size * 0.8),
        ...next.map((neighbor) => neighbor.x - 0.4),
      );
      rect.width = Math.max(rect.width, right - rect.x);
    }
    pieces.push({ item, start, end, row, strong, rect });
  };
  for (const item of valid) {
    const row = nearRow(item, rows);
    if (!row) continue;
    const value = item.text.trim();
    const offset = Math.abs(position(item) - row.baseline);
    const script = item.fontSize < row.size * 0.86 && offset > row.size * 0.08;
    const rare = item.fontName !== ordinaryFont && /^(?:\p{L}|[A-Z][A-Za-z\d]{0,3})$/u.test(value);
    const spacedVariable =
      item.fontName !== ordinaryFont && /^(?:[A-Z]\s+){1,3}[A-Z]$/u.test(value);
    const strong =
      math.test(value) ||
      mathFont.test(item.fontName) ||
      script ||
      rare ||
      spacedVariable ||
      (item.width === 0 && /^\p{Mark}+$/u.test(value));
    const mathematicalToken =
      /^[\p{Sm}\p{N}\p{Mark}_()[\]{},.:;!%/·-]+$/u.test(value) ||
      /^\p{L}$/u.test(value) ||
      /^[A-Z]{2,8}$/u.test(value) ||
      /^(?:min|max|sin|cos|tan|log|ln|exp|lim|argmin|argmax)$/u.test(value);
    if (
      (compact.test(value) || spacedVariable) &&
      value.length <= 20 &&
      (strong || mathematicalToken)
    )
      add(item, 0, item.text.length, row, strong);
    else if (script) {
      // PDF producers sometimes leave a subscript and following prose in one run.
      const prefix = /^\s*[\p{L}\p{N}]{1,6}[)\]},.;:]*(?=\s)/u.exec(item.text);
      if (prefix) add(item, 0, prefix[0].length, row, true);
    }
  }
  // A zero-advance combining accent can overprint a compact variable which was
  // emitted separately (including a base and its subscript in the same run).
  for (const seed of [...pieces]) {
    if (seed.item.width !== 0 || !/^\p{Mark}+$/u.test(seed.item.text.trim())) continue;
    for (const item of valid) {
      if (
        item === seed.item ||
        !/^[\p{L}\p{N}]{1,3}$/u.test(item.text.trim()) ||
        item.width <= 0 ||
        item.width > seed.row.size * 2 ||
        Math.abs(position(item) - seed.row.baseline) > seed.row.size * 0.4 ||
        seed.item.x < item.x - seed.row.size * 0.3 ||
        seed.item.x > item.x + item.width + seed.row.size * 0.3
      )
        continue;
      add(item, 0, item.text.length, seed.row, true);
    }
  }
  // A base letter may be the last character of a much longer prose item, e.g. `(R` then superscript 2.
  for (const seed of [...pieces].filter((piece) => piece.strong)) {
    for (const item of valid) {
      if (item === seed.item || item.text.trim().length <= 3 || item.width <= 0) continue;
      if (Math.abs(position(item) - seed.row.baseline) > seed.row.size * 0.35) continue;
      const seedValue = seed.item.text.slice(seed.start, seed.end).trim();
      const script = seed.item.fontSize < seed.row.size * 0.86;
      if (script && Math.abs(item.x + item.width - seed.rect.x) <= seed.row.size * 0.45) {
        const suffix = /[([{]?[\p{L}]{1,3}$/u.exec(item.text);
        if (suffix && (suffix.index === 0 || !/\p{L}/u.test(item.text[suffix.index - 1])))
          add(item, suffix.index, item.text.length, seed.row, true);
      }
      if (/^[)\]}]/u.test(item.text) && gap(seed.rect, item) <= seed.row.size * 0.4)
        add(item, 0, 1, seed.row, false);
      if (
        item.x >= seed.rect.x + seed.rect.width - seed.row.size * 0.15 &&
        gap(seed.rect, item) <= seed.row.size * 0.55
      ) {
        const numeric = /^[+−-]?\d+(?:[.,]\d+)?[%)]?/u.exec(item.text);
        if (numeric && numeric[0].length < item.text.length)
          add(item, 0, numeric[0].length, seed.row, false);
      }
      if (/^[([{]$/u.test(seedValue) && gap(seed.rect, item) <= seed.row.size * 0.25) {
        const prefix = /^[\p{L}\p{N}]{1,3}(?=\W|$)/u.exec(item.text);
        if (prefix) add(item, 0, prefix[0].length, seed.row, false);
      }
    }
  }
  const connected = (a: Piece, b: Piece): boolean => {
    if (a.item === b.item && a.start < b.end && b.start < a.end) return true;
    const root = a.item.text.includes('√') ? a : b.item.text.includes('√') ? b : undefined;
    const radicand = root === a ? b : a;
    const radicalPair =
      root &&
      radicand.rect.x >= root.rect.x + root.rect.width * 0.7 &&
      gap(root.rect, radicand.rect) <= root.row.size * 0.25 &&
      position(radicand.item) >= position(root.item) &&
      position(radicand.item) - position(root.item) <= root.row.size;
    if (
      !radicalPair &&
      a.row !== b.row &&
      Math.abs(a.row.baseline - b.row.baseline) > Math.max(a.row.size, b.row.size) * 0.4
    )
      return false;
    const size = Math.max(a.row.size, b.row.size);
    return (
      gap(a.rect, b.rect) <= size * 0.55 &&
      Math.abs(a.rect.y + a.rect.height / 2 - b.rect.y - b.rect.height / 2) <= size * 1.15
    );
  };
  const pending = new Set(pieces);
  const atoms: InlineMathAtom[] = [];
  for (const seed of pieces.filter((piece) => piece.strong)) {
    if (!pending.has(seed)) continue;
    const group: Piece[] = [];
    const todo = [seed];
    while (todo.length) {
      const piece = todo.pop()!;
      if (!pending.delete(piece)) continue;
      group.push(piece);
      for (const other of pending) if (connected(piece, other)) todo.push(other);
    }
    const radical = group.find((piece) => piece.item.text.includes('√'));
    const radicand =
      radical &&
      group
        .filter(
          (piece) =>
            piece !== radical &&
            piece.rect.x >= radical.rect.x + radical.rect.width * 0.7 &&
            piece.item.fontSize >= radical.item.fontSize * 0.85,
        )
        .sort((a, b) => a.rect.x - b.rect.x)[0];
    const row = radicand?.row ?? seed.row;
    const rect = union(
      group.map((piece) => {
        if (piece !== radical || !radicand || radical.row === radicand.row) return piece.rect;
        const top = Math.max(piece.rect.y, row.baseline - row.size * 0.82);
        return {
          ...piece.rect,
          y: top,
          height: Math.max(0, piece.rect.y + piece.rect.height - top),
        };
      }),
    );
    // Large source illustrations and multi-line display formulas are not inline objects.
    if ((!row.continuation && rect.width > row.rect.width * 0.8) || rect.height > row.size * 3)
      continue;
    const drawings = page.graphicRegions.filter(
      (drawing) =>
        drawing.width <= row.size * 5 &&
        drawing.height <= row.size * 2 &&
        group.some((piece) => intersects(piece.rect, drawing, row.size * 0.2)),
    );
    const hull = union([rect, ...drawings]);
    const padded = clampRect(
      { x: hull.x - 0.3, y: hull.y - 0.3, width: hull.width + 0.6, height: hull.height + 0.6 },
      page.width,
      page.height,
    );
    const order = new Map(page.items.map((item, index) => [item.id, index]));
    group.sort(
      (a, b) => (order.get(a.item.id) ?? 0) - (order.get(b.item.id) ?? 0) || a.start - b.start,
    );
    const spans: InlineMathAtom['spans'] = [];
    for (const piece of group) {
      const previous = spans.at(-1);
      if (previous?.sourceId === piece.item.id && piece.start <= previous.end)
        previous.end = Math.max(previous.end, piece.end);
      else spans.push({ sourceId: piece.item.id, start: piece.start, end: piece.end });
    }
    atoms.push({
      rect: padded,
      sourceIds: [...new Set(group.map((piece) => piece.item.id))],
      spans,
      fontSize: row.size,
      baselineY: row.baseline,
    });
  }
  return atoms;
}
