import { textVide } from 'text-vide';
import type { ReadingBlock } from './model';

export interface BionicSegment {
  text: string;
  bold: boolean;
}

const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' });

/** Plain text only: never interpret the library's output as document HTML. */
export function bionicSegments(text: string): BionicSegment[] {
  if (!text) return [];
  let marker = '\ue000';
  while (text.includes(marker)) marker += '\ue000';
  const open = marker + '\ue001';
  const close = marker + '\ue002';
  const formatted = textVide(text, {
    fixationPoint: 3,
    sep: [open, close],
    ignoreHtmlTag: false,
    ignoreHtmlEntity: false,
  });
  const ranges: { start: number; end: number }[] = [];
  let offset = 0;
  let position = 0;
  while (position < formatted.length) {
    const start = formatted.indexOf(open, position);
    if (start < 0) break;
    offset += start - position;
    const end = formatted.indexOf(close, start + open.length);
    if (end < 0) break;
    const length = end - start - open.length;
    ranges.push({ start: offset, end: offset + length });
    offset += length;
    position = end + close.length;
  }
  const result: BionicSegment[] = [];
  let range = 0;
  // Snap UTF-16 fixation boundaries to whole glyph clusters (accents, astral text).
  for (const cluster of graphemes.segment(text)) {
    while (range < ranges.length && ranges[range].end <= cluster.index) range++;
    const bold =
      range < ranges.length && ranges[range].start < cluster.index + cluster.segment.length;
    const previous = result.at(-1);
    if (previous?.bold === bold) previous.text += cluster.segment;
    else result.push({ text: cluster.segment, bold });
  }
  return result;
}

export function bionicBlock(block: ReadingBlock): boolean {
  return (
    !block.running &&
    !['toc', 'index', 'table'].includes(block.semantic ?? '') &&
    ['paragraph', 'list', 'footnote', 'reference'].includes(block.kind)
  );
}
