import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import {
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  StandardFonts,
  decodePDFRawStream,
  rgb,
} from 'pdf-lib';
import { strFromU8, unzipSync } from 'fflate';
import type { LayoutDocument, RegionPlacement } from '../../src/core/model';

interface RotationSnapshot {
  layout: LayoutDocument;
  fontSizes: Record<string, number>;
}

// Four unequal-position colors reveal direction errors, clipping, or stretching.
const colors = {
  red: [255, 0, 0],
  green: [0, 255, 0],
  blue: [0, 0, 255],
  yellow: [255, 255, 0],
};

async function asymmetricFigure(): Promise<Buffer> {
  const drawing = await PDFDocument.create();
  const chart = drawing.addPage([600, 120]);
  for (const [x, y, color] of [
    [0, 60, rgb(1, 0, 0)],
    [300, 60, rgb(0, 1, 0)],
    [0, 0, rgb(0, 0, 1)],
    [300, 0, rgb(1, 1, 0)],
  ] as const)
    chart.drawRectangle({ x, y, width: 300, height: 60, color });
  const source = await PDFDocument.create();
  const original = source.addPage([700, 500]);
  const font = await source.embedFont(StandardFonts.Helvetica);
  original.drawText('Searchable ordinary prose above the drawing.', {
    x: 50,
    y: 420,
    size: 12,
    font,
  });
  original.drawPage(await source.embedPage(chart), { x: 50, y: 220, width: 600, height: 120 });
  original.drawText('Figure 1. Four colored corners remain together.', {
    x: 50,
    y: 205,
    size: 10,
    font,
  });
  original.drawText('Searchable ordinary prose below the drawing.', {
    x: 50,
    y: 160,
    size: 12,
    font,
  });
  return Buffer.from(await source.save());
}

for (const automatic of [true, false]) {
  test(`PDF and EPUB preserve the same ${automatic ? 'rotated' : 'original'} figure pixels`, async ({
    page,
  }, info) => {
    await page.addInitScript(() => {
      const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          this.addEventListener('message', ({ data }) => {
            if (data.type === 'result' && data.value?.layout)
              (window as Window & { rotationSnapshot?: RotationSnapshot }).rotationSnapshot = {
                layout: data.value.layout,
                fontSizes: Object.fromEntries(
                  data.value.reading.blocks.map((block: { id: string; fontSize: number }) => [
                    block.id,
                    block.fontSize,
                  ]),
                ),
              };
          });
        }
      };
    });
    await page.goto('');
    await page.getByRole('spinbutton', { name: '가로', exact: true }).fill('110');
    await page.getByRole('spinbutton', { name: '세로', exact: true }).fill('175');
    const rotation = page.getByRole('checkbox', { name: '큰 표·그림 자동 회전', exact: true });
    await expect(rotation).toBeChecked();
    if (!automatic) await rotation.uncheck();
    await page.locator('#pdf-file-input').setInputFiles({
      name: 'asymmetric-figure.pdf',
      mimeType: 'application/pdf',
      buffer: await asymmetricFigure(),
    });
    await expect(page.locator('[data-scope]')).toHaveAttribute('data-scope', 'preview', {
      timeout: 60_000,
    });
    await page.getByRole('button', { name: '변환', exact: true }).click();
    await expect(page.locator('[data-scope]')).toHaveAttribute('data-scope', 'full', {
      timeout: 60_000,
    });
    await expect(page.locator('.error-message')).toHaveCount(0);
    const snapshot = await page.evaluate(
      () => (window as Window & { rotationSnapshot?: RotationSnapshot }).rotationSnapshot!,
    );
    const regions = snapshot.layout.pages
      .flatMap((output) => output.placements)
      .filter(
        (placement): placement is RegionPlacement =>
          placement.type === 'region' && !placement.decoration,
      );
    expect(regions).toHaveLength(1);
    const placement = regions[0];
    expect(placement.rotation).toBe(automatic ? 90 : undefined);
    const originalRatio = placement.sourceRect.width / placement.sourceRect.height;
    expect(originalRatio).toBeGreaterThan(4.5);
    expect(originalRatio).toBeLessThan(5.1);
    expect(placement.width / placement.height).toBeCloseTo(
      automatic ? 1 / originalRatio : originalRatio,
      3,
    );

    const download = async (format: 'PDF' | 'EPUB') => {
      const pending = page.waitForEvent('download');
      await page.getByRole('button', { name: `${format} 다운로드`, exact: true }).click();
      const file = await pending;
      const path = info.outputPath(file.suggestedFilename());
      await file.saveAs(path);
      return readFile(path);
    };
    const pdf = await PDFDocument.load(await download('PDF'));
    const images = pdf.context
      .enumerateIndirectObjects()
      .flatMap(([, object]) =>
        object instanceof PDFRawStream &&
        object.dict.get(PDFName.of('Subtype')) === PDFName.of('Image') &&
        object.dict.get(PDFName.of('ColorSpace')) === PDFName.of('DeviceRGB')
          ? [object]
          : [],
      );
    expect(images).toHaveLength(1);
    const image = images[0];
    const width = image.dict.lookup(PDFName.of('Width'), PDFNumber).asNumber();
    const height = image.dict.lookup(PDFName.of('Height'), PDFNumber).asNumber();
    const rgbPixels = decodePDFRawStream(image).decode();
    const locations = [
      [0.2, 0.2],
      [0.8, 0.2],
      [0.2, 0.8],
      [0.8, 0.8],
    ];
    const pdfSamples = locations.map(([x, y]) => {
      const offset = (Math.floor(height * y) * width + Math.floor(width * x)) * 3;
      return [...rgbPixels.subarray(offset, offset + 3)];
    });
    const files = unzipSync(await download('EPUB'));
    const pngs = Object.entries(files).filter(([path]) => path.endsWith('.png'));
    expect(pngs).toHaveLength(1);
    const actual = await page.evaluate(
      async ({ bytes, locations }) => {
        const bitmap = await createImageBitmap(
          new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
        );
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext('2d')!;
        context.drawImage(bitmap, 0, 0);
        bitmap.close();
        return {
          width: canvas.width,
          height: canvas.height,
          samples: locations.map(([x, y]) =>
            [
              ...context.getImageData(
                Math.floor(canvas.width * x),
                Math.floor(canvas.height * y),
                1,
                1,
              ).data,
            ].slice(0, 3),
          ),
        };
      },
      { bytes: [...pngs[0][1]], locations },
    );
    expect(actual.width).toBe(width);
    expect(actual.height).toBe(height);
    expect(actual.width / actual.height).toBeCloseTo(
      automatic ? 1 / originalRatio : originalRatio,
      2,
    );
    expect(pdfSamples).toEqual(actual.samples);
    expect(actual.samples).toEqual(
      automatic
        ? [colors.blue, colors.red, colors.yellow, colors.green]
        : [colors.red, colors.green, colors.blue, colors.yellow],
    );
    const chapters = Object.entries(files)
      .filter(([path]) => /chapter-.*\.xhtml$/u.test(path))
      .map(([, bytes]) => strFromU8(bytes))
      .join(' ');
    expect(chapters).toContain('Searchable ordinary prose above the drawing.');
    expect(chapters).toContain('Searchable ordinary prose below the drawing.');
    // EPUB's source-size width must describe the rotated PNG, rather than its old landscape width.
    const figureWidth = Number(
      chapters.match(/class="source-region"><img[^>]*style="width:([\d.]+)em/u)?.[1],
    );
    expect(figureWidth).toBeCloseTo(
      (automatic ? placement.sourceRect.height : placement.sourceRect.width) /
        snapshot.fontSizes[placement.blockId],
      3,
    );
  });
}
