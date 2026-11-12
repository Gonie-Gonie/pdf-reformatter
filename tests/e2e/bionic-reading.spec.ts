import fontkit from '@pdf-lib/fontkit';
import { expect, test } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  StandardFonts,
  decodePDFRawStream,
  rgb,
} from 'pdf-lib';

const english = 'Readable collaboration keeps every original word intact.';
const korean = '한글 본문을 강조해도 내용은 그대로 유지됩니다.';
const title = 'Bionic reading sample';

async function originalPdf(): Promise<Buffer> {
  const document = await PDFDocument.create();
  document.registerFontkit(fontkit);
  const englishFont = await document.embedFont(StandardFonts.Helvetica);
  const koreanFont = await document.embedFont(
    await readFile(resolve('public/fonts/NotoSansKR-Regular.ttf')),
    { subset: true },
  );
  const page = document.addPage([612, 792]);
  page.drawText(title, { x: 48, y: 730, font: englishFont, size: 20 });
  page.drawText(english, { x: 48, y: 675, font: englishFont, size: 12 });
  page.drawText(korean, { x: 48, y: 625, font: koreanFont, size: 12 });
  const prefix = 'The coefficient (R';
  const exponentX = 48 + englishFont.widthOfTextAtSize(prefix, 12);
  page.drawText(prefix, { x: 48, y: 570, font: englishFont, size: 12 });
  page.drawText('2', { x: exponentX, y: 574, font: englishFont, size: 8 });
  page.drawText(') remains embedded in readable prose.', {
    x: exponentX + englishFont.widthOfTextAtSize('2', 8),
    y: 570,
    font: englishFont,
    size: 12,
  });
  page.drawRectangle({ x: 48, y: 365, width: 220, height: 95, color: rgb(0.1, 0.3, 0.8) });
  page.drawText('Figure 1. Original colored drawing.', {
    x: 48,
    y: 347,
    font: englishFont,
    size: 10,
  });
  return Buffer.from(await document.save());
}

async function download(page: Page, info: TestInfo, format: 'PDF' | 'EPUB') {
  const waiting = page.waitForEvent('download');
  await page.getByRole('button', { name: `${format} 다운로드`, exact: true }).click();
  const file = await waiting;
  const path = info.outputPath(file.suggestedFilename());
  await file.saveAs(path);
  expect(await file.failure()).toBeNull();
  return readFile(path);
}

/** Inspect fonts actually selected for nonempty text operators, not merely embedded fonts. */
async function usedFonts(bytes: Buffer) {
  const document = await PDFDocument.load(bytes);
  const names = new Set<string>();
  for (const page of document.getPages()) {
    const fonts = page.node.Resources()?.lookup(PDFName.of('Font'), PDFDict);
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray ? contents.asArray() : [contents];
    for (const entry of streams) {
      if (!entry) continue;
      const stream = document.context.lookup(entry);
      if (!(stream instanceof PDFRawStream)) continue;
      const operators = new TextDecoder().decode(decodePDFRawStream(stream).decode());
      for (const match of operators.matchAll(/\/([^\s]+)\s+[\d.]+\s+Tf([\s\S]*?)ET/gu)) {
        if (!/<[0-9a-f]+>\s*Tj/iu.test(match[2])) continue;
        const font = fonts?.lookup(PDFName.of(match[1]), PDFDict);
        const name = font?.lookup(PDFName.of('BaseFont'), PDFName).decodeText();
        if (name) names.add(name);
      }
    }
  }
  return [...names];
}

async function inspectText(bytes: Buffer) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({
    data: new Uint8Array(bytes),
    standardFontDataUrl:
      resolve('node_modules/pdfjs-dist/standard_fonts').replaceAll('\\', '/') + '/',
    useSystemFonts: false,
  });
  try {
    const pdf = await task.promise;
    const fragments: string[] = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const viewport = page.getViewport({ scale: 1 });
      for (const item of (await page.getTextContent({ disableNormalization: true })).items) {
        if (!('str' in item) || !item.str.trim()) continue;
        fragments.push(item.str);
        const x = item.transform[4],
          y = item.transform[5];
        expect(x).toBeGreaterThanOrEqual(-0.5);
        expect(x + item.width).toBeLessThanOrEqual(viewport.width + 0.5);
        expect(y).toBeGreaterThanOrEqual(-0.5);
        expect(y).toBeLessThanOrEqual(viewport.height + 0.5);
      }
    }
    return fragments.join('');
  } finally {
    await task.destroy();
  }
}

for (const [family, enabled] of [
  ['serif', true],
  ['sans', true],
  ['serif', false],
] as const) {
  test(`bionic reading ${enabled ? 'on' : 'off'} preserves downloaded ${family} PDF and EPUB`, async ({
    page,
  }, info) => {
    await page.goto('');
    await expect(page.getByRole('heading', { name: '조정', exact: true })).toBeVisible();
    const checkbox = page.getByRole('checkbox', { name: '바이오닉 리딩 적용', exact: true });
    await expect(checkbox).not.toBeChecked();
    if (family === 'sans') await page.getByRole('button', { name: '고딕', exact: true }).click();
    if (enabled) await checkbox.check();
    await page.locator('#pdf-file-input').setInputFiles({
      name: 'bionic-reading.pdf',
      mimeType: 'application/pdf',
      buffer: await originalPdf(),
    });
    await expect(page.locator('[data-scope]')).toHaveAttribute('data-scope', 'preview', {
      timeout: 60_000,
    });
    await page.getByRole('button', { name: '변환', exact: true }).click();
    await expect(page.locator('[data-scope]')).toHaveAttribute('data-scope', 'full', {
      timeout: 60_000,
    });
    await expect(page.locator('.error-message')).toHaveCount(0);
    const pdf = await download(page, info, 'PDF');
    const fonts = await usedFonts(pdf);
    const primary = family === 'serif' ? 'NotoSerif' : 'NotoSans';
    expect(fonts.some((font) => font.includes(`${primary}-Regular`))).toBe(true);
    expect(fonts.some((font) => font.includes('NotoSansKR-Regular'))).toBe(true);
    expect(fonts.some((font) => font.includes(`${primary}-Bold`))).toBe(enabled);
    expect(fonts.some((font) => font.includes('NotoSansKR-Bold'))).toBe(enabled);
    const normalize = (text: string) => text.replace(/[\s\u00ad-]/gu, '');
    const text = normalize(await inspectText(pdf));
    expect(text).toContain(normalize(english));
    expect(text).toContain(normalize(korean));
    expect(text).toContain(normalize(title));

    const files = unzipSync(await download(page, info, 'EPUB'));
    const chapters = Object.entries(files)
      .filter(([path]) => /chapter-.*\.xhtml$/u.test(path))
      .map(([, content]) => strFromU8(content));
    const publication = await page.evaluate((sources) => {
      const documents = sources.map((source) =>
        new DOMParser().parseFromString(source, 'application/xml'),
      );
      if (documents.some((document) => document.querySelector('parsererror')))
        throw new Error('Invalid publication XML');
      return {
        text: documents
          .map((document) => document.querySelector('body')?.textContent ?? '')
          .join(' '),
        boldCount: documents.reduce(
          (sum, document) => sum + document.querySelectorAll('b.bionic').length,
          0,
        ),
        headingBold: documents.reduce(
          (sum, document) =>
            sum + document.querySelectorAll('h2 .bionic,h3 .bionic,.caption .bionic').length,
          0,
        ),
        math: documents.flatMap((document) =>
          [...document.querySelectorAll('img.inline-math')].map((image) => ({
            alt: image.getAttribute('alt'),
            style: image.getAttribute('style'),
          })),
        ),
      };
    }, chapters);
    expect(normalize(publication.text)).toContain(normalize(english));
    expect(normalize(publication.text)).toContain(normalize(korean));
    expect(publication.boldCount > 0).toBe(enabled);
    expect(publication.headingBold).toBe(0);
    expect(publication.math.length).toBeGreaterThan(0);
    expect(publication.math.some((image) => image.alt?.includes('R'))).toBe(true);
    const css = strFromU8(files['EPUB/styles.css']);
    expect(Boolean(files[`EPUB/fonts/${primary}-Bold.ttf`])).toBe(enabled);
    expect(Boolean(files['EPUB/fonts/NotoSansKR-Bold.ttf'])).toBe(enabled);
    if (enabled) {
      expect(css).toContain(`src:url("fonts/${primary}-Bold.ttf");font-weight:bold;`);
      expect(css).toContain('src:url("fonts/NotoSansKR-Bold.ttf");font-weight:bold;');
    }
    const images = Object.entries(files).filter(([path]) => path.endsWith('.png'));
    const blue = await page.evaluate(
      async (pngs) => {
        let count = 0;
        for (const bytes of pngs) {
          const bitmap = await createImageBitmap(
            new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
          );
          const canvas = document.createElement('canvas');
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          const context = canvas.getContext('2d')!;
          context.drawImage(bitmap, 0, 0);
          bitmap.close();
          const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
          for (let offset = 0; offset < data.length; offset += 4)
            if (data[offset + 2] > data[offset] + 80 && data[offset + 2] > data[offset + 1] + 80)
              count++;
        }
        return count;
      },
      images.map(([, bytes]) => [...bytes]),
    );
    expect(blue).toBeGreaterThan(1000);
    const viewer = page.getByRole('region', { name: '변환 결과 PDF 뷰어', exact: true });
    await expect(viewer).toHaveAttribute('aria-busy', 'false');
    await viewer.locator('canvas').screenshot({ path: info.outputPath('bionic-result.png') });
  });
}
