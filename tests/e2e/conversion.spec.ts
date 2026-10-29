import { test, expect } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PDFDocument, PDFName, PDFNumber, StandardFonts, degrees, rgb } from 'pdf-lib';
import type { SavedProject, VerificationReport } from '../../src/core/model';

const fixture = resolve('.cache/fixtures/mixed-document.pdf');
const fixtureName = 'mixed-document.pdf';

async function openFixture(page: Page) {
  await page.goto('');
  await page.locator('#pdf-file-input').setInputFiles(fixture);
  await expect(page.getByRole('heading', { name: fixtureName, exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByRole('button', { name: '전체 변환', exact: true })).toBeEnabled();
  await expect(page.locator('.error-message')).toHaveCount(0);
}

async function convert(page: Page, preview = false) {
  await page
    .getByRole('button', { name: preview ? '범위 미리보기' : '전체 변환', exact: true })
    .click();
  await page.waitForFunction(
    () =>
      !!document.querySelector('.error-message') ||
      (!!document.querySelector('.downloads-panel') && !document.querySelector('.progress-card')),
  );
  await expect(page.locator('.error-message')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^읽기본 PDF/ })).toBeEnabled();
}

async function download(page: Page, name: string | RegExp, info: TestInfo) {
  const waiting = page.waitForEvent('download');
  await page.getByRole('button', { name, exact: typeof name === 'string' }).click();
  const result = await waiting;
  const path = info.outputPath(result.suggestedFilename());
  await result.saveAs(path);
  expect(await result.failure()).toBeNull();
  return { name: result.suggestedFilename(), bytes: await readFile(path), path };
}

async function outputText(bytes: Uint8Array): Promise<string> {
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
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent({ disableNormalization: true });
      pages.push(content.items.flatMap((item) => ('str' in item ? [item.str] : [])).join(' '));
    }
    return pages.join('\n').replace(/\s+/gu, ' ').trim();
  } finally {
    await task.destroy();
  }
}

test('full local conversion produces readable PDFs, traceable report, and no external requests', async ({
  page,
}, info) => {
  const external: string[] = [],
    badResponses: string[] = [],
    pageErrors: string[] = [];
  page.on('request', (request) => {
    if (
      /^https?:/u.test(request.url()) &&
      new URL(request.url()).origin !== 'http://127.0.0.1:4173'
    )
      external.push(request.url());
  });
  page.on('response', (response) => {
    if (response.status() >= 400) badResponses.push(`${response.status()} ${response.url()}`);
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await openFixture(page);
  await convert(page);

  const reading = await download(page, /^읽기본 PDF/, info);
  const comparison = await download(page, /^원문 대조 합본/, info);
  const reportFile = await download(page, 'JSON', info);
  const htmlFile = await download(page, '보고서 HTML', info);
  const report = JSON.parse(reportFile.bytes.toString('utf8')) as VerificationReport;
  const readingPdf = await PDFDocument.load(reading.bytes);
  const comparisonPdf = await PDFDocument.load(comparison.bytes);

  expect(reading.name).toBe('mixed-document-reading.pdf');
  expect(comparison.name).toBe('mixed-document-comparison.pdf');
  expect(report.schemaVersion).toBe(1);
  expect(report.scope).toBe('full');
  expect(report.sourcePages).toBe(3);
  expect(report.selectedPages).toEqual([1, 2, 3]);
  expect(report.sourceHash).toMatch(/^[a-f0-9]{64}$/u);
  expect(report.reflowedBlocks).toBeGreaterThan(0);
  expect(report.preservedBlocks).toBeGreaterThan(0);
  expect(report.checks.every((check) => check.passed)).toBe(true);
  expect(report.blocks.every((block) => block.outputPages.length > 0)).toBe(true);
  expect(readingPdf.getPageCount()).toBe(report.outputPages);
  expect(comparisonPdf.getPageCount()).toBe(report.outputPages + 3);
  for (const pdfPage of readingPdf.getPages()) {
    expect(pdfPage.getWidth()).toBe(492);
    expect(pdfPage.getHeight()).toBe(546);
  }
  const text = await outputText(reading.bytes);
  expect(text).toContain('한글 문단의 줄바꿈');
  expect(text).toContain('This document was written specifically for testing PDF reflow.');
  expect(text).toContain('Its words, chart and table are synthetic.');
  expect(text).toContain('The output should remain within the usable margins.');
  const compact = text.replace(/\s+/gu, '');
  expect(compact).toContain('이문서는PDF재조판을시험하기위해직접작성한합성자료입니다.');
  expect(compact).toContain('전체문서의처리경로와배치검사를보고서에기록합니다.');
  expect(text).not.toMatch(/[\ufffd堺]/u);
  const leftStart = text.indexOf('Left column begins here.');
  const leftTail = text.indexOf('keeps those corrections.');
  const rightStart = text.indexOf('Right column begins here.');
  expect(leftStart).toBeGreaterThanOrEqual(0);
  expect(leftTail).toBeGreaterThan(leftStart);
  expect(rightStart).toBeGreaterThan(leftTail);
  expect(htmlFile.bytes.toString('utf8')).toContain('PDF Reflow 검증 보고서');
  await expect(
    page.getByRole('region', { name: '읽기본 PDF 뷰어' }).locator('canvas'),
  ).toBeVisible();
  await page.getByLabel('글자 크기', { exact: true }).fill('14');
  await expect(page.getByRole('button', { name: /^읽기본 PDF/ })).toBeDisabled();
  await expect(page.getByText('다시 변환 필요', { exact: true })).toBeVisible();
  expect(external).toEqual([]);
  expect(badResponses).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('text and order corrections survive file export, IndexedDB restore, and re-layout', async ({
  page,
}, info) => {
  await openFixture(page);
  await page.getByLabel('글자 크기', { exact: true }).fill('14');
  await page.getByRole('tab', { name: /^영역 검토/ }).click();
  await page.locator('.block-row').first().click();
  await page.getByRole('combobox', { name: /^처리 방식/ }).selectOption('paragraph');
  await page
    .getByRole('textbox', { name: '읽기본 텍스트', exact: true })
    .fill('Edited reading proof. 사용자 보정 유지 확인.');
  await page.getByRole('button', { name: '아래로', exact: true }).click();
  await page.getByRole('button', { name: '작업 저장', exact: true }).click();
  await expect(page.getByText('이 브라우저에 저장됨', { exact: true })).toBeVisible();
  const exported = await download(page, '작업 내보내기', info);
  const project = JSON.parse(exported.bytes.toString('utf8')) as SavedProject;
  expect(project.config.fontSizePt).toBe(14);
  expect(
    Object.values(project.overrides).some((override) =>
      override.text?.startsWith('Edited reading proof.'),
    ),
  ).toBe(true);
  expect(Object.values(project.overrides).some((override) => override.order !== undefined)).toBe(
    true,
  );
  expect(project).not.toHaveProperty('sourceBytes');

  await page.reload();
  await expect(page.getByRole('button', { name: '작업 복원', exact: true })).toBeVisible();
  const choosing = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '작업 복원', exact: true }).click();
  await (await choosing).setFiles(fixture);
  await expect(
    page.getByText('원본 해시를 확인하고 설정과 수동 보정을 복원했습니다.', { exact: true }),
  ).toBeVisible({ timeout: 60_000 });
  await expect(page.getByLabel('글자 크기', { exact: true })).toHaveValue('14');

  // Import restores an exported project even after a separate configuration change.
  await page.getByLabel('글자 크기', { exact: true }).fill('15');
  await page.locator('input[type="file"]').nth(1).setInputFiles(exported.path);
  await expect(page.getByLabel('글자 크기', { exact: true })).toHaveValue('14');
  await page.getByRole('tab', { name: /^영역 검토/ }).click();
  await expect(page.locator('.block-row').filter({ hasText: 'Edited reading proof.' })).toHaveCount(
    1,
  );
  await convert(page);
  const reportFile = await download(page, 'JSON', info);
  const report = JSON.parse(reportFile.bytes.toString('utf8')) as VerificationReport;
  expect(report.config.fontSizePt).toBe(14);
  expect(report.warnings.some((warning) => warning.includes('사용자가 수정한 텍스트'))).toBe(true);
  expect(report.checks.every((check) => check.passed)).toBe(true);

  // A matching file name cannot bypass the source fingerprint check.
  const wrongHash = 'a'.repeat(64);
  const mismatched = {
    ...project,
    sourceHash: wrongHash,
    reading: { ...project.reading, sourceHash: wrongHash },
    config: { ...project.config, fontSizePt: 17 },
  };
  await page
    .locator('input[type="file"]')
    .nth(1)
    .setInputFiles({
      name: 'mismatched.reflow-project',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(mismatched)),
    });
  await expect(page.locator('.restore-banner')).toBeVisible();
  await page.locator('#pdf-file-input').setInputFiles(fixture);
  await expect(page.getByRole('alert')).toContainText(
    '선택한 PDF가 저장된 작업의 원본과 다릅니다.',
    { timeout: 60_000 },
  );
  await expect(page.getByLabel('글자 크기', { exact: true })).toHaveValue('14');
});

test('partial preview is explicit and invalid page ranges are rejected', async ({ page }, info) => {
  await openFixture(page);
  await page.locator('.preview-range summary').click();
  await page.getByLabel('원문 쪽수', { exact: true }).fill('0');
  await page.getByRole('button', { name: '범위 미리보기', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('쪽수는 1부터 3 사이');
  await page.getByLabel('원문 쪽수', { exact: true }).fill('2');
  await convert(page, true);
  const reportFile = await download(page, 'JSON', info);
  const readingFile = await download(page, /^읽기본 PDF/, info);
  const report = JSON.parse(reportFile.bytes.toString('utf8')) as VerificationReport;
  expect(report.scope).toBe('preview');
  expect(report.selectedPages).toEqual([2]);
  expect(report.blocks.every((block) => block.sourcePage === 2)).toBe(true);
  expect(report.checks.find((check) => check.name === '변환 범위')?.passed).toBe(false);
  expect(readingFile.name).toContain('-preview-');
  await expect(page.getByText('부분 미리보기', { exact: true }).first()).toBeVisible();
});

test('invalid PDF fails safely and cancelling a conversion permits a new conversion', async ({
  page,
}) => {
  await page.goto('');
  await page.locator('#pdf-file-input').setInputFiles({
    name: 'invalid.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('this is not a PDF'),
  });
  await expect(page.getByRole('alert')).toContainText('PDF 형식이 아닙니다');
  await page.locator('#pdf-file-input').setInputFiles(fixture);
  await expect(page.getByRole('button', { name: '전체 변환', exact: true })).toBeEnabled({
    timeout: 60_000,
  });
  await page.getByRole('button', { name: '전체 변환', exact: true }).click();
  await page.getByRole('button', { name: '취소', exact: true }).click();
  await expect(
    page.getByText('작업을 취소했습니다. 설정과 보정은 유지됩니다.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '전체 변환', exact: true })).toBeEnabled();
  await convert(page);
});

test('demo and document workspace fit a mobile viewport without horizontal overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('');
  const overflow = () =>
    page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  expect(await overflow()).toBe(false);
  await page.getByRole('button', { name: /^예제 PDF로 체험하기/ }).click();
  await expect(page.getByRole('button', { name: '전체 변환', exact: true })).toBeEnabled({
    timeout: 60_000,
  });
  expect(await overflow()).toBe(false);
  await convert(page);
  expect(await overflow()).toBe(false);
  await page.getByRole('tab', { name: /^영역 검토/ }).click();
  await page.locator('.block-row').first().click();
  expect(await overflow()).toBe(false);
});

test('a scanned page is preserved without inventing OCR text', async ({ page }, info) => {
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
  await page.locator('#pdf-file-input').setInputFiles({
    name: 'synthetic-scan.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await scanPdf.save()),
  });
  await expect(page.getByRole('button', { name: '전체 변환', exact: true })).toBeEnabled();
  await convert(page);
  const downloaded = await download(page, 'JSON', info);
  const report = JSON.parse(downloaded.bytes.toString('utf8')) as VerificationReport;
  expect(report.sourcePages).toBe(1);
  expect(report.reflowedBlocks).toBe(0);
  expect(report.preservedBlocks).toBe(1);
  expect(report.blocks[0].route).toBe('raster-preserved');
  expect(report.checks.every((check) => check.passed)).toBe(true);
});

test('rotation, CropBox offset, and UserUnit preserve a visible page without clipping errors', async ({
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
  await page.locator('#pdf-file-input').setInputFiles({
    name: 'rotated-cropped.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await document.save()),
  });
  await expect(page.getByRole('button', { name: '전체 변환', exact: true })).toBeEnabled();
  await convert(page);
  const downloaded = await download(page, 'JSON', info);
  const report = JSON.parse(downloaded.bytes.toString('utf8')) as VerificationReport;
  expect(report.sourcePages).toBe(1);
  expect(report.preservedBlocks).toBeGreaterThan(0);
  expect(report.checks.every((check) => check.passed)).toBe(true);
  await expect(page.getByRole('region', { name: '원문 PDF 뷰어' }).locator('canvas')).toBeVisible();
});
