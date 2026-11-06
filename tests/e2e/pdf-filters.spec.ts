import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFName } from 'pdf-lib';
import { unzipSync } from 'fflate';

test('worker rendering preserves luminosity masks and alpha transfer maps without a DOM', async ({
  page,
}, info) => {
  const source = await PDFDocument.create();
  const context = source.context;
  const original = source.addPage([300, 200]);
  const mask = (stream: string, resources = {}) =>
    context.register(
      context.flateStream(stream, {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 300, 200],
        Group: { S: 'Transparency', CS: 'DeviceGray', I: true },
        Resources: resources,
      }),
    );
  const luminosity = mask('0.5 g 0 0 300 200 re f');
  const alpha = mask('q /Quarter gs 0 g 0 0 300 200 re f Q', {
    ExtGState: { Quarter: { Type: 'ExtGState', ca: 0.25 } },
  });
  const inverse = context.register(
    context.obj({ FunctionType: 2, Domain: [0, 1], C0: [1], C1: [0], N: 1 }),
  );
  original.node.set(
    PDFName.of('Resources'),
    context.obj({
      ExtGState: {
        Luminosity: { Type: 'ExtGState', SMask: { S: 'Luminosity', G: luminosity } },
        Alpha: { Type: 'ExtGState', SMask: { S: 'Alpha', G: alpha, TR: inverse } },
      },
    }),
  );
  original.node.addContentStream(
    context.register(
      context.flateStream(
        'q /Luminosity gs 1 0 0 rg 30 50 100 100 re f Q\nq /Alpha gs 0 0 1 rg 180 50 90 100 re f Q',
      ),
    ),
  );

  await page.goto('');
  await page.locator('#pdf-file-input').setInputFiles({
    name: 'soft-masks.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await source.save()),
  });
  const toolbar = page.locator('[data-scope]');
  await expect(toolbar).toHaveAttribute('data-scope', 'preview', { timeout: 60_000 });
  await page.getByRole('button', { name: '변환', exact: true }).click();
  await expect(toolbar).toHaveAttribute('data-scope', 'full', { timeout: 60_000 });
  await expect(page.locator('.error-message')).toHaveCount(0);
  const waiting = page.waitForEvent('download');
  await page.getByRole('button', { name: 'EPUB 다운로드', exact: true }).click();
  const download = await waiting;
  const path = info.outputPath(download.suggestedFilename());
  await download.saveAs(path);
  const images = Object.entries(unzipSync(await readFile(path))).filter(([name]) =>
    name.endsWith('.png'),
  );
  expect(images).toHaveLength(1);
  const samples = await page.evaluate(
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
      return [0.2, 0.75].map((x) =>
        [
          ...context.getImageData(Math.floor(canvas.width * x), Math.floor(canvas.height / 2), 1, 1)
            .data,
        ].slice(0, 3),
      );
    },
    [...images[0][1]],
  );
  for (const [actual, expected] of samples.map((value, index) => [
    value,
    index ? [64, 64, 255] : [255, 127, 127],
  ]))
    for (let channel = 0; channel < 3; channel++)
      expect(Math.abs(actual[channel] - expected[channel])).toBeLessThanOrEqual(5);
});
