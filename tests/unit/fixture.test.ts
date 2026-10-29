/// <reference types="node" />
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { FIXTURE_MANIFEST, generateMixedDocumentPdf } from '../helpers/mixed-document';

const fontData = async (name: string) =>
  new Uint8Array(await readFile(new URL(`../../public/fonts/${name}`, import.meta.url)));

describe('synthetic PDF and Korean font regression', () => {
  it('generates a complete mixed three-page PDF from bundled fonts', async () => {
    const bytes = await generateMixedDocumentPdf(fontData);
    const document = await PDFDocument.load(bytes);
    expect(document.getPageCount()).toBe(FIXTURE_MANIFEST.pages);
    expect(document.getTitle()).toBe(FIXTURE_MANIFEST.title);
    expect(bytes.byteLength).toBeGreaterThan(10000);
  });

  it('retains the actual outlines of every Korean glyph after PDF font subsetting', async () => {
    const bytes = await fontData('NotoSansKR-Regular.ttf');
    const original = fontkit.create(bytes);
    const text = '한글 문단의 줄바꿈 합성 자료입니다.ABC123';
    const document = await PDFDocument.create();
    document.registerFontkit(fontkit);
    const font = await document.embedFont(bytes, { subset: true });
    const encoded = font.encodeText(text).asBytes();
    document.addPage().drawText(text, { x: 30, y: 700, size: 20, font });
    const reopened = await PDFDocument.load(await document.save());
    const fonts = reopened.getPage(0).node.Resources()!.lookup(PDFName.of('Font'), PDFDict);
    const embedded = reopened.context.lookup(fonts.values()[0], PDFDict);
    const descendant = embedded.lookup(PDFName.of('DescendantFonts'), PDFArray).lookup(0, PDFDict);
    const descriptor = descendant.lookup(PDFName.of('FontDescriptor'), PDFDict);
    const stream = descriptor.lookup(PDFName.of('FontFile2'));
    if (!(stream instanceof PDFRawStream))
      throw new Error('Expected an embedded TrueType font stream.');
    const subset = fontkit.create(decodePDFRawStream(stream).decode());
    const characters = [...text];
    expect(encoded.length).toBe(characters.length * 2);
    for (let index = 0; index < characters.length; index++) {
      const id = encoded[index * 2] * 256 + encoded[index * 2 + 1];
      const expected = original.glyphForCodePoint(characters[index].codePointAt(0)!);
      const actual = subset.getGlyph(id);
      expect(actual.path.toSVG(), `visible outline for ${characters[index]}`).toBe(
        expected.path.toSVG(),
      );
      expect(actual.advanceWidth).toBe(expected.advanceWidth);
    }
  });
});
