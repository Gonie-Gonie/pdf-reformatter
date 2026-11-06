import { finiteRect } from './geometry';
import type { InlineMathSpan, ReadingBlock } from './model';

export interface InlineAtom {
  math: InlineMathSpan;
  text: string;
  sourceStart: number;
  sourceEnd: number;
}
export interface InlineContent {
  text: string;
  atoms: Map<string, InlineAtom>;
}
export const normalizedLength = (text: string): number =>
  text.normalize('NFKC').replace(/[\s\u00ad]/gu, '').length;

/** Layout-only markers keep original mathematical text and source anchors intact. */
export function inlineContent(block: Pick<ReadingBlock, 'text' | 'inlineMath'>): InlineContent {
  const atoms = new Map<string, InlineAtom>();
  let text = '';
  let offset = 0;
  let code = 0xf0000;
  for (const math of [...(block.inlineMath ?? [])].sort((a, b) => a.start - b.start)) {
    if (
      !Number.isInteger(math.start) ||
      !Number.isInteger(math.end) ||
      math.start < offset ||
      math.end <= math.start ||
      math.end > block.text.length ||
      !finiteRect(math.rect) ||
      !Number.isFinite(math.baselineY) ||
      !Number.isFinite(math.fontSize) ||
      math.fontSize <= 0
    )
      continue;
    let marker = String.fromCodePoint(code++);
    while (block.text.includes(marker)) marker = String.fromCodePoint(code++);
    text += block.text.slice(offset, math.start) + marker;
    atoms.set(marker, {
      math,
      text: block.text.slice(math.start, math.end),
      sourceStart: normalizedLength(block.text.slice(0, math.start)),
      sourceEnd: normalizedLength(block.text.slice(0, math.end)),
    });
    offset = math.end;
  }
  text += block.text.slice(offset);
  return { text, atoms };
}

export function inlineFragments(
  text: string,
  atoms: ReadonlyMap<string, InlineAtom>,
): { text: string; atom?: InlineAtom }[] {
  const result: { text: string; atom?: InlineAtom }[] = [];
  let plain = '';
  for (const character of text) {
    const atom = atoms.get(character);
    if (!atom) {
      plain += character;
      continue;
    }
    if (plain) result.push({ text: plain });
    plain = '';
    result.push({ text: atom.text, atom });
  }
  if (plain) result.push({ text: plain });
  return result;
}

/** Only re-typeset characters need an output font; math is drawn from the original. */
export function flowingText(block: Pick<ReadingBlock, 'text' | 'inlineMath'>): string {
  const content = inlineContent(block);
  return inlineFragments(content.text, content.atoms)
    .filter((part) => !part.atom)
    .map((part) => part.text)
    .join('');
}
