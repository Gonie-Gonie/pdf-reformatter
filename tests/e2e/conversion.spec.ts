import { test, expect } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PDFDocument, PDFName, PDFNumber, StandardFonts, degrees, rgb } from 'pdf-lib';

const fixture = resolve('.cache/fixtures/mixed-document.pdf');
const resultToolbar = '[data-scope]';
type PdfInput = string | { name: string; mimeType: string; buffer: Buffer };

async function viewersReady(page: Page) {
  for (const name of ['원문 PDF 뷰어', '변환 결과 PDF 뷰어']) {
    const viewer = page.getByRole('region', { name, exact: true });
    await expect(viewer).toHaveAttribute('aria-busy', 'false', { timeout: 60_000 });
    await expect(viewer.locator('canvas')).toBeVisible();
  }
}

async function uploadPdf(page: Page, input: PdfInput = fixture) {
  await page.locator('#pdf-file-input').setInputFiles(input);
  await expect(page.locator(resultToolbar)).toHaveAttribute('data-scope', 'preview', {
    timeout: 60_000,
  });
  await expect(page.getByRole('button', { name: '변환', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '다운로드', exact: true })).toBeDisabled();
  await expect(page.locator('.error-message')).toHaveCount(0);
  await viewersReady(page);
}

async function convert(page: Page) {
  await page.getByRole('button', { name: '변환', exact: true }).click();
  await expect(page.locator(resultToolbar)).toHaveAttribute('data-scope', 'full', {
    timeout: 60_000,
  });
  await expect(page.locator(resultToolbar)).toHaveAttribute('data-stale', 'false');
  await expect(page.getByRole('button', { name: '다운로드', exact: true })).toBeEnabled();
  await expect(page.locator('.error-message')).toHaveCount(0);
  await viewersReady(page);
}

async function download(page: Page, info: TestInfo) {
  const waiting = page.waitForEvent('download');
  await page.getByRole('button', { name: '다운로드', exact: true }).click();
  const result = await waiting;
  const path = info.outputPath(result.suggestedFilename());
  await result.saveAs(path);
  expect(await result.failure()).toBeNull();
  return { name: result.suggestedFilename(), bytes: await readFile(path) };
}

async function outputText(bytes: Uint8Array, pageNumber?: number): Promise<string> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({
    data: new Uint8Array(bytes),
    standardFontDataUrl:
      resolve('node_modules/pdfjs-dist/standard_fonts').replaceAll('\\', '/') + '/',
    useSystemFonts: false,
  });
  const pdf = await task.promise;
  try {
    const pages: string[] = [];
    for (let number = pageNumber ?? 1; number <= (pageNumber ?? pdf.numPages); number++) {
      const sourcePage = await pdf.getPage(number);
      const content = await sourcePage.getTextContent({ disableNormalization: true });
      pages.push(content.items.flatMap((item) => ('str' in item ? [item.str] : [])).join(' '));
    }
    return pages.join('\n').replace(/\s+/gu, ' ').trim();
  } finally {
    await task.destroy();
  }
}

async function numberedPdf(count: number): Promise<Buffer> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let number = 1; number <= count; number++) {
    const sourcePage = document.addPage([612, 792]);
    const marker = `SourcePage${String(number).padStart(3, '0')}`;
    sourcePage.drawText(`${marker} begins here.`, { x: 48, y: 730, font, size: 14 });
    for (let line = 0; line < 16; line++) {
      sourcePage.drawText(`Sentence ${line + 1} belongs to source page ${number}.`, {
        x: 48,
        y: 690 - line * 23,
        font,
        size: 12,
      });
    }
    sourcePage.drawText(`${marker} ends here.`, { x: 48, y: 280, font, size: 12 });
  }
  return Buffer.from(await document.save());
}

async function expectStableViewers(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolveFrame) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame())),
      ),
  );
  await viewersReady(page);
  const samples = await page.evaluate(async () => {
    const frames: { width: number; height: number; busy: boolean; visible: boolean }[][] = [];
    for (let index = 0; index < 36; index++) {
      await new Promise<void>((resolveFrame) => requestAnimationFrame(() => resolveFrame()));
      frames.push(
        [...document.querySelectorAll<HTMLElement>('.pdf-viewer')].map((viewer) => {
          const canvas = viewer.querySelector('canvas')!;
          const rect = canvas.getBoundingClientRect();
          return {
            width: rect.width,
            height: rect.height,
            busy: viewer.getAttribute('aria-busy') === 'true',
            visible: rect.width > 0 && rect.height > 0,
          };
        }),
      );
    }
    return frames;
  });
  expect(samples[0]).toHaveLength(2);
  for (let viewer = 0; viewer < 2; viewer++) {
    const sizes = samples.map((frame) => frame[viewer]);
    expect(sizes.every((size) => size.visible && !size.busy)).toBe(true);
    expect(
      Math.max(...sizes.map((size) => size.width)) - Math.min(...sizes.map((size) => size.width)),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.max(...sizes.map((size) => size.height)) - Math.min(...sizes.map((size) => size.height)),
    ).toBeLessThanOrEqual(1);
  }
}

async function canvasPixels(page: Page, kind: 'ink' | 'blue') {
  return page
    .getByRole('region', { name: '변환 결과 PDF 뷰어', exact: true })
    .locator('canvas')
    .evaluate((canvas, selected) => {
      const element = canvas as HTMLCanvasElement;
      const pixels = element
        .getContext('2d')!
        .getImageData(0, 0, element.width, element.height).data;
      let matches = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        const [red, green, blue, alpha] = pixels.subarray(index, index + 4);
        if (
          alpha > 200 &&
          (selected === 'blue'
            ? blue > red + 30 && blue > green + 10
            : red < 140 && green < 140 && blue < 140)
        )
          matches++;
      }
      return matches;
    }, kind);
}

test('local conversion preserves Korean, English and column order in the result PDF', async ({
  page,
}, info) => {
  const external: string[] = [],
    badResponses: string[] = [],
    pageErrors: string[] = [];
  const localOrigin = new URL(info.project.use.baseURL!).origin;
  page.on('request', (request) => {
    if (/^https?:/u.test(request.url()) && new URL(request.url()).origin !== localOrigin)
      external.push(request.url());
  });
  page.on('response', (response) => {
    if (response.status() >= 400) badResponses.push(`${response.status()} ${response.url()}`);
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('');
  await uploadPdf(page);
  await convert(page);

  const downloaded = await download(page, info);
  expect(downloaded.name).toBe('mixed-document-formatted.pdf');
  const document = await PDFDocument.load(downloaded.bytes);
  expect(document.getPageCount()).toBeGreaterThan(0);
  for (const outputPage of document.getPages()) {
    expect(outputPage.getWidth()).toBe(492);
    expect(outputPage.getHeight()).toBe(546);
  }
  const text = await outputText(downloaded.bytes);
  expect(text).toContain('한글 문단의 줄바꿈');
  expect(text).toContain('This document was written specifically for testing PDF reflow.');
  expect(text).toContain('Its words, chart and table are synthetic.');
  expect(text).toContain('The output should remain within the usable margins.');
  expect(text.replace(/\s+/gu, '')).toContain(
    '이문서는PDF재조판을시험하기위해직접작성한합성자료입니다.',
  );
  expect(text).not.toMatch(/[\ufffd\u0000]/u);
  const leftStart = text.indexOf('Left column begins here.');
  const leftTail = text.indexOf('after layout changes.');
  const rightStart = text.indexOf('Right column begins here.');
  expect(leftStart).toBeGreaterThanOrEqual(0);
  expect(leftTail).toBeGreaterThan(leftStart);
  expect(rightStart).toBeGreaterThan(leftTail);

  await page.getByLabel('글자 크기', { exact: true }).fill('14');
  await expect(page.getByRole('button', { name: '다운로드', exact: true })).toBeDisabled();
  await expect(page.locator(resultToolbar)).toHaveAttribute('data-stale', 'true');
  expect(external).toEqual([]);
  expect(badResponses).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('preview and full conversion both link pages using their content', async ({ page }, info) => {
  await page.goto('');
  await uploadPdf(page, {
    name: 'twelve-pages.pdf',
    mimeType: 'application/pdf',
    buffer: await numberedPdf(12),
  });
  await expect(page.locator(resultToolbar)).toHaveAttribute(
    'data-selected-pages',
    Array.from({ length: 10 }, (_, index) => index + 1).join(','),
  );
  const sourcePage = page.getByLabel('원문 페이지', { exact: true });
  const outputPage = page.getByLabel('변환 결과 페이지', { exact: true });
  await expect(sourcePage).toHaveAttribute('max', '12');
  await outputPage.fill((await outputPage.getAttribute('max'))!);
  await viewersReady(page);
  await expect(sourcePage).toHaveValue('10');
  await sourcePage.fill('1');
  await viewersReady(page);
  await expect(outputPage).toHaveValue('1');
  await expect(page.locator(resultToolbar)).toHaveAttribute('data-scope', 'preview');

  await convert(page);
  await expect(page.locator(resultToolbar)).toHaveAttribute(
    'data-selected-pages',
    Array.from({ length: 12 }, (_, index) => index + 1).join(','),
  );
  const downloaded = await download(page, info);
  const text = await outputText(downloaded.bytes);
  let previousEnd = -1;
  for (let number = 1; number <= 12; number++) {
    const marker = `SourcePage${String(number).padStart(3, '0')}`;
    const start = text.indexOf(`${marker} begins here.`);
    const end = text.indexOf(`${marker} ends here.`);
    expect(start, `source page ${number} start`).toBeGreaterThan(previousEnd);
    expect(end, `source page ${number} end`).toBeGreaterThan(start);
    previousEnd = end;
  }

  await outputPage.fill((await outputPage.getAttribute('max'))!);
  await viewersReady(page);
  await expect(sourcePage).toHaveValue('12');

  await sourcePage.fill('2');
  await viewersReady(page);
  const linkedPage = Number(await outputPage.inputValue());
  expect(await outputText(downloaded.bytes, linkedPage)).toContain('SourcePage002 begins here.');

  await outputPage.fill('1');
  await viewersReady(page);
  await expect(sourcePage).toHaveValue('1');
});

test('an invalid file and cancellation both permit a new full conversion', async ({
  page,
}, info) => {
  await page.goto('');
  await page.locator('#pdf-file-input').setInputFiles({
    name: 'invalid.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('this is not a PDF'),
  });
  await expect(page.getByRole('alert')).toContainText('PDF 형식이 아닙니다');
  await uploadPdf(page, {
    name: 'retry.pdf',
    mimeType: 'application/pdf',
    buffer: await numberedPdf(36),
  });
  await page.getByRole('button', { name: '변환', exact: true }).click();
  await page.getByRole('button', { name: '취소', exact: true }).click();
  await expect(page.getByRole('button', { name: '변환', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '다운로드', exact: true })).toBeDisabled();
  await convert(page);
  const downloaded = await download(page, info);
  expect(await outputText(downloaded.bytes)).toContain('SourcePage036 ends here.');
});

test('mobile viewers settle after resizing and zooming without horizontal page overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('');
  const overflow = () =>
    page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  expect(await overflow()).toBe(false);
  await uploadPdf(page);
  expect(await overflow()).toBe(false);
  await expectStableViewers(page);
  await page.getByRole('button', { name: '변환 결과 확대', exact: true }).click();
  await expectStableViewers(page);
  expect(await overflow()).toBe(false);
  await page.setViewportSize({ width: 340, height: 640 });
  await expectStableViewers(page);
  await page.getByRole('button', { name: '변환 결과 화면에 맞추기', exact: true }).click();
  await expectStableViewers(page);
  await convert(page);
  expect(await overflow()).toBe(false);
  await page.getByRole('tab', { name: /^검토 필요/u }).click();
  expect(await overflow()).toBe(false);
});

test('a scanned page retains visible content without inventing searchable OCR text', async ({
  page,
}, info) => {
  await page.goto('');
  const imageData = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 600;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, 400, 600);
    context.fillStyle = '#161616';
    context.font = '24px sans-serif';
    context.fillText('Synthetic scanned page', 32, 70);
    context.font = '16px sans-serif';
    context.fillText('Preserve visible text and drawings.', 32, 112);
    context.fillRect(32, 160, 80, 160);
    context.fillRect(132, 220, 80, 100);
    context.fillRect(232, 190, 80, 130);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  const scanPdf = await PDFDocument.create();
  const image = await scanPdf.embedPng(Buffer.from(imageData, 'base64'));
  scanPdf.addPage([400, 600]).drawImage(image, { x: 0, y: 0, width: 400, height: 600 });
  await uploadPdf(page, {
    name: 'synthetic-scan.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await scanPdf.save()),
  });
  await convert(page);
  const downloaded = await download(page, info);
  expect((await PDFDocument.load(downloaded.bytes)).getPageCount()).toBe(1);
  expect(await outputText(downloaded.bytes)).not.toContain('Synthetic scanned page');
  expect(await canvasPixels(page, 'ink')).toBeGreaterThan(1000);
});

test('rotation, CropBox offset and UserUnit preserve the visible colored drawing', async ({
  page,
}, info) => {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const original = document.addPage([612, 792]);
  original.setCropBox(30, 40, 500, 600);
  original.setRotation(degrees(90));
  original.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
  original.drawText('Rotated source with nonzero crop origin', { x: 60, y: 590, font, size: 18 });
  original.drawRectangle({ x: 60, y: 160, width: 200, height: 120, color: rgb(0.2, 0.4, 0.6) });
  await page.goto('');
  await uploadPdf(page, {
    name: 'rotated-cropped.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await document.save()),
  });
  await convert(page);
  const downloaded = await download(page, info);
  expect((await PDFDocument.load(downloaded.bytes)).getPageCount()).toBe(1);
  expect(await canvasPixels(page, 'blue')).toBeGreaterThan(1000);
  await expectStableViewers(page);
});
