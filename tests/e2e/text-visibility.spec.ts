import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { strFromU8, unzipSync } from 'fflate';

async function searchableText(bytes: Uint8Array): Promise<string> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({
    data: bytes.slice(),
    standardFontDataUrl:
      resolve('node_modules/pdfjs-dist/standard_fonts').replaceAll('\\', '/') + '/',
    useSystemFonts: false,
  });
  const pdf = await task.promise;
  try {
    const result: string[] = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      const content = await (await pdf.getPage(number)).getTextContent();
      result.push(content.items.flatMap((item) => ('str' in item ? [item.str] : [])).join(' '));
    }
    return result.join(' ').replace(/\s+/gu, ' ');
  } finally {
    await task.destroy();
  }
}

test('conversion ignores text outside an embedded figure clip and white-on-white code', async ({
  page,
}, info) => {
  const drawing = await PDFDocument.create();
  const chart = drawing.addPage([500, 500]);
  const chartFont = await drawing.embedFont(StandardFonts.Helvetica);
  chart.drawText('Visible chart label', { x: 140, y: 200, size: 14, font: chartFont });
  chart.drawRectangle({ x: 120, y: 120, width: 220, height: 60, color: rgb(0.1, 0.3, 0.8) });
  chart.drawRectangle({ x: 120, y: 240, width: 220, height: 20, color: rgb(0.8, 0.1, 0.1) });
  chart.drawText('HiddenOutsideForm must never enter the article.', {
    x: 20,
    y: 440,
    size: 12,
    font: chartFont,
  });

  const source = await PDFDocument.create();
  const pageFont = await source.embedFont(StandardFonts.TimesRoman);
  const whiteOnlyFont = await source.embedFont(StandardFonts.Courier);
  const original = source.addPage([612, 792]);
  original.drawText('Visible ordinary body remains searchable.', {
    x: 48,
    y: 730,
    size: 12,
    font: pageFont,
  });
  original.drawText('InvisibleCodeOnly = 42;', {
    x: 48,
    y: 650,
    size: 10,
    font: whiteOnlyFont,
    color: rgb(1, 1, 1),
  });
  const figure = await source.embedPage(chart, { left: 100, bottom: 100, right: 400, top: 300 });
  original.drawPage(figure, { x: 90, y: 360, width: 300, height: 200 });
  original.drawText('Fig. 1. Visible chart content only.', {
    x: 90,
    y: 345,
    size: 10,
    font: pageFont,
  });
  const bytes = await source.save();
  const originalText = await searchableText(bytes);
  expect(originalText).toContain('HiddenOutsideForm');
  expect(originalText).toContain('InvisibleCodeOnly');

  await page.goto('');
  await page.locator('#pdf-file-input').setInputFiles({
    name: 'clipped-figure.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(bytes),
  });
  await expect(page.locator('[data-scope]')).toHaveAttribute('data-scope', 'preview', {
    timeout: 60_000,
  });
  await expect(page.getByRole('button', { name: '변환', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '변환', exact: true }).click();
  await expect(page.locator('[data-scope]')).toHaveAttribute('data-scope', 'full', {
    timeout: 60_000,
  });
  await expect(page.locator('.error-message')).toHaveCount(0);
  const download = async (format: 'PDF' | 'EPUB') => {
    const waiting = page.waitForEvent('download');
    await page.getByRole('button', { name: `${format} 다운로드`, exact: true }).click();
    const result = await waiting;
    const path = info.outputPath(result.suggestedFilename());
    await result.saveAs(path);
    expect(await result.failure()).toBeNull();
    return new Uint8Array(await readFile(path));
  };
  const pdfText = await searchableText(await download('PDF'));
  expect(pdfText).toContain('Visible ordinary body remains searchable.');
  expect(pdfText).not.toContain('HiddenOutsideForm');
  expect(pdfText).not.toContain('InvisibleCodeOnly');
  const publication = unzipSync(await download('EPUB'));
  const text = Object.entries(publication)
    .filter(([path]) => path.endsWith('.xhtml'))
    .map(([, value]) => strFromU8(value))
    .join(' ');
  expect(text).toContain('Visible ordinary body remains searchable.');
  expect(text).not.toContain('HiddenOutsideForm');
  expect(text).not.toContain('InvisibleCodeOnly');
  const pngs = Object.entries(publication).filter(([path]) => path.endsWith('.png'));
  expect(pngs).toHaveLength(1);
  const image = await page.evaluate(
    async (data) => {
      const bitmap = await createImageBitmap(
        new Blob([new Uint8Array(data)], { type: 'image/png' }),
      );
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d')!;
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let blue = 0,
        red = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i + 2] > pixels[i] + 60 && pixels[i + 2] > pixels[i + 1] + 60) blue++;
        if (pixels[i] > pixels[i + 1] + 60 && pixels[i] > pixels[i + 2] + 60) red++;
      }
      return { width: canvas.width, height: canvas.height, blue, red };
    },
    [...pngs[0][1]],
  );
  expect(image.width / image.height).toBeCloseTo(300 / 200, 1);
  expect(image.blue).toBeGreaterThan(100);
  expect(image.red).toBeGreaterThan(100);
});
