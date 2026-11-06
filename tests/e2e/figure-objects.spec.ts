import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { PDFDict, PDFDocument, PDFName, PDFRawStream, StandardFonts, rgb } from 'pdf-lib';
import { strFromU8, unzipSync } from 'fflate';

test('one source figure keeps disconnected chart bands and its detached legend together', async ({
  page,
}, info) => {
  // A Form XObject expresses the original figure boundary even when its visible
  // vector ink is disconnected and contains no extractable chart-label text.
  const drawing = await PDFDocument.create();
  const chart = drawing.addPage([400, 250]);
  for (const [y, color] of [
    [200, rgb(0.1, 0.3, 0.8)],
    [130, rgb(0.8, 0.1, 0.1)],
    [60, rgb(0.1, 0.6, 0.2)],
  ] as const) {
    chart.drawRectangle({ x: 20, y, width: 220, height: 5, color });
  }
  chart.drawRectangle({ x: 295, y: 100, width: 70, height: 100, color: rgb(0.6, 0.1, 0.7) });
  chart.drawRectangle({ x: 80, y: 20, width: 80, height: 5, color: rgb(0, 0, 0) });
  const source = await PDFDocument.create();
  const font = await source.embedFont(StandardFonts.Helvetica);
  const original = source.addPage([612, 792]);
  original.drawText('This ordinary paragraph must remain searchable before the figure.', {
    x: 48,
    y: 730,
    size: 12,
    font,
  });
  original.drawText('All chart bands and the detached legend belong to one original object.', {
    x: 48,
    y: 710,
    size: 12,
    font,
  });
  const figure = await source.embedPage(chart);
  original.drawPage(figure, { x: 90, y: 360, width: 400, height: 250 });
  original.drawText('Fig. 1. Disconnected chart bands with a detached legend.', {
    x: 90,
    y: 345,
    size: 10,
    font,
  });

  await page.goto('');
  await page.locator('#pdf-file-input').setInputFiles({
    name: 'figure-object.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await source.save()),
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
    return readFile(path);
  };
  const pdf = await PDFDocument.load(await download('PDF'));
  const images = pdf.getPages().flatMap((output) => {
    const resources = output.node.Resources();
    const objects = resources?.lookup(PDFName.of('XObject'), PDFDict);
    return (objects?.entries() ?? []).flatMap(([, reference]) => {
      const object = pdf.context.lookup(reference);
      return object instanceof PDFRawStream &&
        object.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')
        ? [object]
        : [];
    });
  });
  expect(images).toHaveLength(1);

  const files = unzipSync(await download('EPUB'));
  const publicationText = Object.entries(files)
    .filter(([path]) => path.endsWith('.xhtml'))
    .map(([, bytes]) => strFromU8(bytes))
    .join(' ');
  expect(publicationText).toContain(
    'This ordinary paragraph must remain searchable before the figure.',
  );
  const pngs = Object.entries(files).filter(([path]) => path.endsWith('.png'));
  expect(pngs).toHaveLength(1);
  const image = await page.evaluate(
    async (bytes) => {
      const bitmap = await createImageBitmap(
        new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
      );
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d')!;
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const counts = { blue: 0, red: 0, green: 0, purple: 0 };
      for (let index = 0; index < pixels.length; index += 4) {
        const [red, green, blue] = pixels.subarray(index, index + 3);
        if (blue > red + 60 && blue > green + 60) counts.blue++;
        if (red > green + 60 && red > blue + 60) counts.red++;
        if (green > red + 60 && green > blue + 60) counts.green++;
        if (red > green + 60 && blue > green + 60) counts.purple++;
      }
      return { width: canvas.width, height: canvas.height, counts };
    },
    [...pngs[0][1]],
  );
  expect(image.width / image.height).toBeCloseTo(400 / 250, 1);
  for (const count of Object.values(image.counts)) expect(count).toBeGreaterThan(100);
});
