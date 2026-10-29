import { PDFName } from 'pdf-lib';
import type { PDFDocument } from 'pdf-lib';
import { findLayoutAnchor } from '../../core/layout';
import type { MeasureText } from '../../core/layout';
import type {
  BlockAnchor,
  LayoutDocument,
  Placement,
  ReadingBlock,
  ReadingDocument,
  Rect,
} from '../../core/model';

interface LocatedAnchor {
  page: number;
  rect: Rect;
}

function normalized(text: string): string {
  return text.normalize('NFKC').replace(/[\s\u00ad]/gu, '');
}

function validAnchor(
  output: PDFDocument,
  anchor: LocatedAnchor | undefined,
): anchor is LocatedAnchor {
  if (
    !anchor ||
    !Number.isInteger(anchor.page) ||
    anchor.page < 1 ||
    anchor.page > output.getPageCount()
  )
    return false;
  const { rect } = anchor;
  const page = output.getPage(anchor.page - 1);
  return (
    [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) &&
    rect.width > 0 &&
    rect.height > 0 &&
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.x + rect.width <= page.getWidth() + 0.1 &&
    rect.y + rect.height <= page.getHeight() + 0.1
  );
}

function indexPlacements(layout: LayoutDocument): Map<string, Map<number, Placement[]>> {
  const index = new Map<string, Map<number, Placement[]>>();
  for (const page of layout.pages) {
    for (const placement of page.placements) {
      if (placement.decoration) continue;
      let block = index.get(placement.blockId);
      if (!block) {
        block = new Map();
        index.set(placement.blockId, block);
      }
      const placements = block.get(page.number) ?? [];
      placements.push(placement);
      block.set(page.number, placements);
    }
  }
  return index;
}

function labelRect(
  location: LocatedAnchor,
  block: ReadingBlock,
  anchor: BlockAnchor,
  placed: Map<number, Placement[]>,
  measure: MeasureText,
  note: boolean,
): LocatedAnchor | undefined {
  const placement = placed
    .get(location.page)
    ?.find(
      (item) =>
        item.blockId === block.id &&
        !(item.type === 'text' && item.decoration) &&
        location.rect.x >= item.x - 0.1 &&
        location.rect.x < item.x + item.width &&
        location.rect.y >= item.y - 0.1 &&
        location.rect.y < item.y + item.height,
    );
  if (!placement) return undefined;
  const span = anchor.sourceId
    ? block.sourceSpans?.find((item) => item.sourceId === anchor.sourceId)
    : undefined;
  const start = (span?.start ?? 0) + (anchor.offset ?? 0);
  const remaining = normalized(block.text).slice(start);
  const label =
    note && block.noteLabel
      ? normalized(block.noteLabel)
      : (remaining.match(/^(?:\[\d+\]|\(\d+\)|\d+|[†‡*])/u)?.[0] ?? [...remaining][0]);
  if (!label) return undefined;
  const size =
    placement.type === 'text'
      ? placement.fontSize
      : (block.fontSize * placement.width) / placement.sourceRect.width;
  const width = measure(label, size);
  const height = Math.min(location.rect.height, size * 1.25);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0)
    return undefined;
  return {
    page: location.page,
    rect: {
      x: location.rect.x,
      y: location.rect.y,
      width: Math.min(width + 1, placement.x + placement.width - location.rect.x),
      height,
    },
  };
}

function addLink(output: PDFDocument, source: LocatedAnchor, target: LocatedAnchor): void {
  const page = output.getPage(source.page - 1);
  const destination = output.getPage(target.page - 1);
  const { rect } = source;
  const annotation = output.context.obj({
    Type: PDFName.of('Annot'),
    Subtype: PDFName.of('Link'),
    Rect: [
      rect.x,
      page.getHeight() - rect.y - rect.height,
      rect.x + rect.width,
      page.getHeight() - rect.y,
    ],
    Border: [0, 0, 0],
    Dest: [
      destination.ref,
      PDFName.of('XYZ'),
      target.rect.x,
      destination.getHeight() - target.rect.y,
      null,
    ],
    P: page.ref,
  });
  page.node.addAnnot(output.context.register(annotation));
}

/** Note navigation stays inside the converted PDF and covers labels rather than entire paragraphs. */
export function addNoteLinks(
  output: PDFDocument,
  reading: ReadingDocument,
  layout: LayoutDocument,
  measure: MeasureText,
): void {
  const blocks = new Map(reading.blocks.map((block) => [block.id, block]));
  const placed = indexPlacements(layout);
  const locations = new Map<string, LocatedAnchor | undefined>();
  const locate = (anchor: BlockAnchor): LocatedAnchor | undefined => {
    const key = JSON.stringify([anchor.blockId, anchor.sourceId ?? null, anchor.offset ?? 0]);
    if (!locations.has(key)) locations.set(key, findLayoutAnchor(layout, reading, anchor, measure));
    return locations.get(key);
  };
  const backlinks = new Set<string>();
  const forwardLinks = new Set<string>();
  for (const reference of reading.references ?? []) {
    const source = blocks.get(reference.source.blockId);
    const note = blocks.get(reference.targetBlockId);
    const sourcePlacement = placed.get(reference.source.blockId);
    const notePlacement = placed.get(reference.targetBlockId);
    if (
      !source ||
      !note ||
      source.kind === 'lineNumber' ||
      note.kind === 'lineNumber' ||
      source.running ||
      note.running ||
      !sourcePlacement ||
      !notePlacement ||
      (reference.source.sourceId &&
        (!source.sourceIds.includes(reference.source.sourceId) ||
          !source.sourceSpans?.some((span) => span.sourceId === reference.source.sourceId)))
    )
      continue;
    const noteAnchor: BlockAnchor = {
      blockId: note.id,
      ...(note.sourceSpans?.[0] ? { sourceId: note.sourceSpans[0].sourceId } : {}),
    };
    const sourceLocation = locate(reference.source);
    const noteLocation = locate(noteAnchor);
    if (!validAnchor(output, sourceLocation) || !validAnchor(output, noteLocation)) continue;
    const glyph = labelRect(
      sourceLocation,
      source,
      reference.source,
      sourcePlacement,
      measure,
      false,
    );
    if (!validAnchor(output, glyph)) continue;
    const key = `${glyph.page}:${glyph.rect.x}:${glyph.rect.y}:${glyph.rect.width}:${glyph.rect.height}:${note.id}`;
    if (forwardLinks.has(key)) continue;
    addLink(output, glyph, noteLocation);
    forwardLinks.add(key);
    if (backlinks.has(note.id)) continue;
    const label = labelRect(noteLocation, note, noteAnchor, notePlacement, measure, true);
    if (!validAnchor(output, label)) continue;
    addLink(output, label, sourceLocation);
    backlinks.add(note.id);
  }
}
