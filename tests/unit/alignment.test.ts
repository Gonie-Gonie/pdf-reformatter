import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDocument, PDFName, PDFNumber } from 'pdf-lib';
import type { PDFDict } from 'pdf-lib';
import { readTextAlignments } from '../../src/adapters/pdf/alignment';

async function fixture(build: (document: PDFDocument, root: PDFDict) => void) {
  const document = await PDFDocument.create();
  document.addPage([400, 600]);
  document.addPage([400, 600]);
  const root = document.context.obj({ Type: 'StructTreeRoot' });
  document.catalog.set(PDFName.of('StructTreeRoot'), document.context.register(root));
  build(document, root);
  return document.save();
}

describe('explicit source paragraph alignment', () => {
  it('reads paragraph attributes and inherited page references', async () => {
    const bytes = await fixture((document, root) => {
      root.set(
        PDFName.of('K'),
        document.context.obj({
          Type: 'StructElem',
          S: 'Sect',
          Pg: document.getPages()[0].ref,
          A: { O: 'Layout', TextAlign: 'Justify' },
          K: [
            { Type: 'StructElem', S: 'P', K: [0, 1] },
            {
              Type: 'StructElem',
              S: 'P',
              A: { O: 'Layout', TextAlign: 'Center' },
              K: 2,
            },
          ],
        }),
      );
    });
    const result = await readTextAlignments(bytes);
    expect([...result.get(1)!]).toEqual([
      [0, 'justify'],
      [1, 'justify'],
      [2, 'center'],
    ]);
    expect(result.has(2)).toBe(false);
  });

  it('applies ClassMap values before direct attributes and honors MCR page overrides', async () => {
    const bytes = await fixture((document, root) => {
      root.set(
        PDFName.of('ClassMap'),
        document.context.obj({
          Body: [{ O: 'Layout', TextAlign: 'Start' }, 0],
          Tail: { O: 'Layout', TextAlign: 'End' },
        }),
      );
      root.set(
        PDFName.of('K'),
        document.context.obj({
          S: 'Sect',
          Pg: document.getPages()[0].ref,
          K: [
            { S: 'P', C: ['Body', 0], K: 3 },
            {
              S: 'P',
              C: ['Body', 0, 'Tail'],
              A: [{ O: 'Layout', TextAlign: 'Center' }, 2],
              K: { Type: 'MCR', Pg: document.getPages()[1].ref, MCID: 4 },
            },
          ],
        }),
      );
    });
    const result = await readTextAlignments(bytes);
    expect(result.get(1)?.get(3)).toBe('left');
    expect(result.get(2)?.get(4)).toBe('center');
  });

  it('maps logical edges in RTL and skips vertical writing modes', async () => {
    const bytes = await fixture((document, root) => {
      root.set(
        PDFName.of('K'),
        document.context.obj({
          S: 'Sect',
          Pg: document.getPages()[0].ref,
          A: { O: 'Layout', WritingMode: 'RlTb', TextAlign: 'Start' },
          K: [
            { S: 'P', K: 0 },
            {
              S: 'P',
              A: { O: 'Layout', TextAlign: 'End' },
              K: 1,
            },
            {
              S: 'P',
              A: { O: 'Layout', WritingMode: 'TbRl', TextAlign: 'Center' },
              K: 2,
            },
          ],
        }),
      );
    });
    const result = await readTextAlignments(bytes);
    expect([...result.get(1)!]).toEqual([
      [0, 'right'],
      [1, 'left'],
    ]);
  });

  it('does not treat form or annotation MCIDs as page content and drops conflicting mappings', async () => {
    const bytes = await fixture((document, root) => {
      root.set(
        PDFName.of('K'),
        document.context.obj({
          S: 'Sect',
          Pg: document.getPages()[0].ref,
          A: { O: 'Layout', TextAlign: 'Start' },
          K: [
            { S: 'P', K: 0 },
            {
              S: 'P',
              A: { O: 'Layout', TextAlign: 'End' },
              K: 0,
            },
            { Type: 'MCR', MCID: 1, Stm: {} },
            { Type: 'OBJR', MCID: 2 },
          ],
        }),
      );
    });
    expect(await readTextAlignments(bytes)).toEqual(new Map());
  });

  it('ignores other attribute owners and safely skips cyclic or malformed optional structure', async () => {
    const bytes = await fixture((document, root) => {
      const node = document.context.obj({
        S: 'P',
        Pg: document.getPages()[0].ref,
        A: { O: 'Table', TextAlign: 'Center' },
      });
      const nodeRef = document.context.register(node);
      const kids = PDFArray.withContext(document.context);
      kids.push(nodeRef);
      kids.push(PDFNumber.of(3));
      node.set(PDFName.of('K'), kids);
      root.set(PDFName.of('K'), nodeRef);
    });
    expect(await readTextAlignments(bytes)).toEqual(new Map());
    expect(await readTextAlignments(new Uint8Array([0, 1, 2]))).toEqual(new Map());
  });
});
