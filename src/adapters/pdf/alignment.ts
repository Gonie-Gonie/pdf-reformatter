import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber } from 'pdf-lib';
import type { PDFObject } from 'pdf-lib';

type Alignment = 'left' | 'right' | 'center' | 'justify';
type LogicalAlignment = 'Start' | 'End' | 'Center' | 'Justify';
interface LayoutAttributes {
  align?: LogicalAlignment;
  writingMode: string;
}

/** Read only explicit tagged-PDF layout attributes; missing metadata is not an error. */
export async function readTextAlignments(
  bytes: Uint8Array,
): Promise<Map<number, Map<number, Alignment>>> {
  const result = new Map<number, Map<number, Alignment>>();
  try {
    const document = await PDFDocument.load(bytes, {
      ignoreEncryption: true,
      updateMetadata: false,
    });
    if (document.isEncrypted) return result;
    const context = document.context;
    const resolve = (value: PDFObject | undefined) => context.lookup(value);
    const root = resolve(document.catalog.get(PDFName.of('StructTreeRoot')));
    if (!(root instanceof PDFDict)) return result;
    const classes = resolve(root.get(PDFName.of('ClassMap')));
    const pageNumbers = new Map<PDFDict, number>(
      document.getPages().map((page, index) => [page.node, index + 1]),
    );
    const name = (value: PDFObject | undefined) => {
      const object = resolve(value);
      return object instanceof PDFName ? object.decodeText() : undefined;
    };
    const attributes = (
      value: PDFObject | undefined,
      inherited: LayoutAttributes,
      path = new Set<PDFObject>(),
      depth = 0,
    ): LayoutAttributes => {
      const object = resolve(value);
      if (!object || path.has(object) || depth > 16) return inherited;
      const state = { ...inherited };
      if (object instanceof PDFDict) {
        if (name(object.get(PDFName.of('O'))) !== 'Layout') return state;
        const align = name(object.get(PDFName.of('TextAlign')));
        if (align === 'Start' || align === 'End' || align === 'Center' || align === 'Justify')
          state.align = align;
        const writingMode = name(object.get(PDFName.of('WritingMode')));
        if (writingMode) state.writingMode = writingMode;
      } else if (object instanceof PDFArray) {
        path.add(object);
        let current = state;
        for (let index = 0; index < object.size(); index++)
          current = attributes(object.get(index), current, path, depth + 1);
        path.delete(object);
        return current;
      }
      return state;
    };
    const classAttributes = (value: PDFObject | undefined, inherited: LayoutAttributes) => {
      let state = inherited;
      const object = resolve(value);
      const apply = (entry: PDFObject | undefined) => {
        const key = resolve(entry);
        if (classes instanceof PDFDict && key instanceof PDFName)
          state = attributes(classes.get(key), state);
      };
      if (object instanceof PDFArray)
        for (let index = 0; index < object.size(); index++) apply(object.get(index));
      else apply(object);
      return state;
    };
    const alignment = (state: LayoutAttributes): Alignment | undefined => {
      if (state.writingMode !== 'LrTb' && state.writingMode !== 'RlTb') return undefined;
      if (state.align === 'Center') return 'center';
      if (state.align === 'Justify') return 'justify';
      if (state.align === 'Start') return state.writingMode === 'RlTb' ? 'right' : 'left';
      if (state.align === 'End') return state.writingMode === 'RlTb' ? 'left' : 'right';
      return undefined;
    };
    const conflicts = new Set<string>();
    const assign = (
      value: PDFObject | undefined,
      page: number | undefined,
      state: LayoutAttributes,
    ) => {
      const object = resolve(value);
      const align = alignment(state);
      if (!(object instanceof PDFNumber) || page === undefined || !align) return;
      const mcid = object.asNumber();
      if (!Number.isSafeInteger(mcid) || mcid < 0) return;
      const key = `${page}:${mcid}`;
      if (conflicts.has(key)) return;
      const pageResult = result.get(page) ?? new Map<number, Alignment>();
      const previous = pageResult.get(mcid);
      if (previous && previous !== align) {
        pageResult.delete(mcid);
        conflicts.add(key);
      } else pageResult.set(mcid, align);
      if (pageResult.size) result.set(page, pageResult);
      else result.delete(page);
    };
    const path = new Set<PDFObject>();
    let visited = 0;
    const visit = (
      value: PDFObject | undefined,
      page: number | undefined,
      inherited: LayoutAttributes,
      depth: number,
    ) => {
      if (depth > 128 || visited++ >= 100_000) return;
      const object = resolve(value);
      if (!object || path.has(object)) return;
      if (object instanceof PDFNumber) {
        assign(object, page, inherited);
        return;
      }
      path.add(object);
      if (object instanceof PDFArray) {
        for (let index = 0; index < object.size(); index++)
          visit(object.get(index), page, inherited, depth + 1);
      } else if (object instanceof PDFDict) {
        const pageKey = PDFName.of('Pg');
        const pageObject = resolve(object.get(pageKey));
        const ownPage = object.has(pageKey)
          ? pageObject instanceof PDFDict
            ? pageNumbers.get(pageObject)
            : undefined
          : page;
        const type = name(object.get(PDFName.of('Type')));
        if (type !== 'OBJR') {
          if (type === 'MCR' || object.has(PDFName.of('MCID'))) {
            // Form XObjects have their own MCID namespace; page-only mapping would be ambiguous.
            if (!object.has(PDFName.of('Stm')) && !object.has(PDFName.of('StmOwn')))
              assign(object.get(PDFName.of('MCID')), ownPage, inherited);
          } else {
            const state = attributes(
              object.get(PDFName.of('A')),
              classAttributes(object.get(PDFName.of('C')), inherited),
            );
            visit(object.get(PDFName.of('K')), ownPage, state, depth + 1);
          }
        }
      }
      path.delete(object);
    };
    visit(root, undefined, { writingMode: 'LrTb' }, 0);
  } catch {
    // PDF.js remains responsible for visible content when optional tagging cannot be read.
    return new Map();
  }
  return result;
}
