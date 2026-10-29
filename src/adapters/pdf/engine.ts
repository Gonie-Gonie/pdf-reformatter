import { getDocument, GlobalWorkerOptions, Util, version } from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { analyzeDocument, applyOverrides } from '../../core/analyze';
import { layoutDocument } from '../../core/layout';
import { validateConfig } from '../../core/config';
import { collectCriticalIssues } from '../../core/issues';
import type {
  ConversionResult,
  LayoutConfig,
  Overrides,
  Progress,
  ReadingDocument,
  Rect,
  SourceDocument,
  SourcePage,
} from '../../core/model';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
const base = import.meta.env.BASE_URL;
const asset = (path: string) => new URL(`${base}${path}`, self.location.origin).href;
type ProgressCallback = (p: Progress) => void;

/** PDF.js temporary canvases work in a DedicatedWorker, with no DOM. */
class WorkerCanvasFactory {
  create(width: number, height: number) {
    const canvas = new OffscreenCanvas(Math.ceil(width), Math.ceil(height));
    return { canvas, context: canvas.getContext('2d')! };
  }
  reset(target: { canvas: OffscreenCanvas }, width: number, height: number) {
    target.canvas.width = Math.ceil(width);
    target.canvas.height = Math.ceil(height);
  }
  destroy(target: {
    canvas: OffscreenCanvas | null;
    context: OffscreenCanvasRenderingContext2D | null;
  }) {
    if (target.canvas) {
      target.canvas.width = 0;
      target.canvas.height = 0;
    }
    target.canvas = null;
    target.context = null;
  }
}

export async function openPdf(bytes: Uint8Array, password?: string): Promise<PDFDocumentProxy> {
  return getDocument({
    data: bytes.slice(),
    password,
    stopAtErrors: true,
    cMapUrl: asset('pdfjs/cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: asset('pdfjs/standard_fonts/'),
    wasmUrl: asset('pdfjs/wasm/'),
    useSystemFonts: false,
    useWorkerFetch: true,
    CanvasFactory: WorkerCanvasFactory,
    ownerDocument: {
      fonts: (self as unknown as { fonts: FontFaceSet }).fonts,
    } as unknown as HTMLDocument,
  }).promise;
}

async function raster(page: PDFPageProxy, scale: number, rect?: Rect): Promise<OffscreenCanvas> {
  const viewport = page.getViewport({ scale });
  const area = rect ?? {
    x: 0,
    y: 0,
    width: viewport.width / scale,
    height: viewport.height / scale,
  };
  const canvas = new OffscreenCanvas(
    Math.max(1, Math.ceil(area.width * scale)),
    Math.max(1, Math.ceil(area.height * scale)),
  );
  const context = canvas.getContext('2d', { willReadFrequently: !rect })!;
  await page.render({
    canvas: canvas as unknown as HTMLCanvasElement,
    canvasContext: context as unknown as CanvasRenderingContext2D,
    viewport,
    transform: [1, 0, 0, 1, -area.x * scale, -area.y * scale],
    background: '#ffffff',
  }).promise;
  return canvas;
}

/** Find visible non-text ink; favor conservative preservation over dropped drawings. */
async function detectGraphics(page: PDFPageProxy, source: SourcePage): Promise<Rect[]> {
  const scale = Math.min(1, 1400 / Math.max(source.width, source.height));
  const canvas = await raster(page, scale);
  const ctx = canvas.getContext('2d')!;
  const { width, height } = canvas;
  const pixels = ctx.getImageData(0, 0, width, height).data;
  const mask = new Uint8Array(width * height);
  for (const item of source.items) {
    const x0 = Math.max(0, Math.floor((item.x - 2) * scale));
    const x1 = Math.min(width, Math.ceil((item.x + item.width + 2) * scale));
    const y0 = Math.max(0, Math.floor((item.y - 2) * scale));
    const y1 = Math.min(height, Math.ceil((item.y + item.height + 2) * scale));
    for (let y = y0; y < y1; y++) mask.fill(1, y * width + x0, y * width + x1);
  }
  const cell = Math.max(3, Math.round(6 * scale));
  const cols = Math.ceil(width / cell),
    rows = Math.ceil(height / cell);
  const cells = new Uint16Array(cols * rows);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const p = y * width + x,
        k = p * 4;
      if (
        !mask[p] &&
        Math.min(pixels[k], pixels[k + 1], pixels[k + 2]) < 218 &&
        pixels[k + 3] > 50
      ) {
        cells[Math.floor(y / cell) * cols + Math.floor(x / cell)]++;
      }
    }
  const regions: Rect[] = [];
  const seen = new Uint8Array(cells.length);
  for (let start = 0; start < cells.length; start++) {
    if (seen[start] || cells[start] < 2) continue;
    const queue = [start];
    seen[start] = 1;
    let minX = cols,
      minY = rows,
      maxX = 0,
      maxY = 0,
      ink = 0;
    for (let head = 0; head < queue.length; head++) {
      const p = queue[head],
        x = p % cols,
        y = Math.floor(p / cols);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      ink += cells[p];
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx,
            ny = y + dy,
            next = ny * cols + nx;
          if (nx >= 0 && nx < cols && ny >= 0 && ny < rows && !seen[next] && cells[next] >= 2) {
            seen[next] = 1;
            queue.push(next);
          }
        }
    }
    if (ink < 8) continue;
    const x = Math.max(0, (minX * cell) / scale - 4),
      y = Math.max(0, (minY * cell) / scale - 4);
    regions.push({
      x,
      y,
      width: Math.min(source.width - x, ((maxX + 1) * cell) / scale + 4 - x),
      height: Math.min(source.height - y, ((maxY + 1) * cell) / scale + 4 - y),
    });
  }
  for (let i = 0; i < regions.length; i++)
    for (let j = i + 1; j < regions.length; j++) {
      const a = regions[i],
        b = regions[j],
        gap = 14;
      if (
        a.x <= b.x + b.width + gap &&
        a.x + a.width + gap >= b.x &&
        a.y <= b.y + b.height + gap &&
        a.y + a.height + gap >= b.y
      ) {
        const x = Math.min(a.x, b.x),
          y = Math.min(a.y, b.y);
        regions[i] = {
          x,
          y,
          width: Math.max(a.x + a.width, b.x + b.width) - x,
          height: Math.max(a.y + a.height, b.y + b.height) - y,
        };
        regions.splice(j, 1);
        i = -1;
        break;
      }
    }
  canvas.width = 0;
  canvas.height = 0;
  return regions;
}

export async function extractPdf(
  bytes: Uint8Array,
  name: string,
  progress: ProgressCallback,
  password?: string,
  pageLimit?: number,
): Promise<{ source: SourceDocument; reading: ReadingDocument }> {
  if (typeof OffscreenCanvas === 'undefined')
    throw new Error(
      '이 브라우저는 OffscreenCanvas를 지원하지 않습니다. 최신 Chrome 또는 Edge에서 열어 주세요.',
    );
  if (pageLimit !== undefined && (!Number.isInteger(pageLimit) || pageLimit < 1))
    throw new RangeError('분석할 페이지 수는 1 이상의 정수여야 합니다.');
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer))]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
  const pdf = await openPdf(bytes, password);
  const source: SourceDocument = {
    schemaVersion: 1,
    hash,
    name,
    pageCount: pdf.numPages,
    pages: [],
    engine: `PDF.js ${version}`,
  };
  try {
    const pageCount = Math.min(pageLimit ?? pdf.numPages, pdf.numPages);
    for (let number = 1; number <= pageCount; number++) {
      progress({
        stage: 'extracting',
        current: number,
        total: pageCount,
        message: `원문 ${number} / ${pageCount}쪽 분석 중`,
      });
      const page = await pdf.getPage(number),
        viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent({ disableNormalization: true });
      const sourcePage: SourcePage = {
        number,
        width: viewport.width,
        height: viewport.height,
        rotation: page.rotate,
        items: [],
        graphicRegions: [],
        warnings: [],
      };
      const scale = Math.hypot(viewport.transform[0], viewport.transform[1]);
      for (let i = 0; i < content.items.length; i++) {
        const item = content.items[i];
        if (!('str' in item) || !item.str.trim()) continue;
        const transform = Util.transform(viewport.transform, item.transform);
        const size = Math.hypot(transform[2], transform[3]) || item.height * scale;
        const style = content.styles[item.fontName];
        const ascent = style?.ascent ?? 0.85,
          descent = style?.descent ?? -0.2;
        sourcePage.items.push({
          id: `p${number}-t${i}`,
          text: item.str,
          x: transform[4],
          y: transform[5] - size * ascent,
          width: item.width * scale,
          height: Math.max(size * (ascent - descent), size),
          fontSize: size,
          fontName: `${style?.fontFamily ?? ''} ${item.fontName}`,
          hasEOL: item.hasEOL,
        });
        if (Math.abs(transform[1]) > 0.1 || item.dir === 'ttb' || item.dir === 'rtl') {
          sourcePage.warnings.push(
            '회전 문자·세로쓰기·오른쪽에서 왼쪽 쓰기는 페이지 원형으로 보존합니다.',
          );
        }
      }
      const annotations = await page.getAnnotations({ intent: 'display' });
      const omittedAnnotation = annotations.some((annotation) => {
        if (
          annotation.subtype === 'Link' ||
          annotation.subtype === 'Popup' ||
          annotation.hasAppearance ||
          (annotation.annotationFlags & (1 | 2 | 32)) !== 0
        )
          return false;
        return (
          (annotation.subtype === 'Widget' &&
            annotation.fieldValue !== undefined &&
            annotation.fieldValue !== null &&
            String(annotation.fieldValue).trim() !== '') ||
          (annotation.subtype === 'Text' && Boolean(annotation.contentsObj?.str)) ||
          annotation.subtype === 'FileAttachment'
        );
      });
      if (omittedAnnotation)
        sourcePage.issues = [
          {
            id: `p${number}-unsupported-annotation`,
            code: 'unsupported-annotation',
            sourcePage: number,
            message: '주석이나 양식의 내용이 결과에서 생략될 수 있습니다.',
            rect: { x: 0, y: 0, width: sourcePage.width, height: sourcePage.height },
          },
        ];
      sourcePage.graphicRegions = sourcePage.items.length
        ? await detectGraphics(page, sourcePage)
        : [];
      source.pages.push(sourcePage);
      page.cleanup();
    }
    progress({
      stage: 'analyzing',
      current: pageCount,
      total: pageCount,
      message: '읽기 순서와 문단을 구성하는 중',
    });
    return { source, reading: analyzeDocument(source) };
  } finally {
    await pdf.loadingTask.destroy();
  }
}

const fontCache = new Map<string, Promise<Uint8Array>>();
async function fontBytes(name: string): Promise<Uint8Array> {
  if (!fontCache.has(name))
    fontCache.set(
      name,
      fetch(asset(`fonts/${name}`))
        .then(async (response) => {
          if (!response.ok)
            throw new Error(`글꼴을 불러올 수 없습니다: ${name} (${response.status})`);
          return new Uint8Array(await response.arrayBuffer());
        })
        .catch((error) => {
          fontCache.delete(name);
          throw error;
        }),
    );
  return fontCache.get(name)!;
}
export async function exportPdf(
  bytes: Uint8Array,
  source: SourceDocument,
  reading: ReadingDocument,
  inputConfig: LayoutConfig,
  overrides: Overrides,
  progress: ProgressCallback,
  selectedPages?: number[],
  password?: string,
): Promise<ConversionResult> {
  const config = validateConfig(inputConfig);
  const scope = selectedPages ? ('preview' as const) : ('full' as const);
  const range = selectedPages
    ? [...selectedPages]
    : Array.from({ length: source.pageCount }, (_, index) => index + 1);
  if (
    !range.length ||
    new Set(range).size !== range.length ||
    range.some((number) => !Number.isInteger(number) || number < 1 || number > source.pageCount)
  )
    throw new Error('변환할 페이지 범위가 올바르지 않습니다.');
  const availablePages = new Set(source.pages.map((page) => page.number));
  if (range.some((number) => !availablePages.has(number))) {
    const analyzed = await extractPdf(
      bytes,
      source.name,
      progress,
      password,
      scope === 'preview' ? Math.max(...range) : undefined,
    );
    source = analyzed.source;
    reading = analyzed.reading;
  }
  const selected = new Set(range);
  const scopedSource: SourceDocument = {
    ...source,
    pages: source.pages.filter((page) => selected.has(page.number)),
  };
  const scopedReading: ReadingDocument = {
    ...reading,
    blocks: reading.blocks.filter((block) => selected.has(block.sourcePage)),
  };
  const effective = applyOverrides(scopedReading, overrides);
  if (!effective.blocks.length)
    throw new Error('변환할 내용이 없습니다. 제외 설정을 확인해 주세요.');
  for (const block of effective.blocks) {
    const page = scopedSource.pages.find((item) => item.number === block.sourcePage);
    const rect = block.rect;
    if (
      !page ||
      ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ||
      rect.width <= 0 ||
      rect.height <= 0 ||
      rect.x < -0.1 ||
      rect.y < -0.1 ||
      rect.x + rect.width > page.width + 0.5 ||
      rect.y + rect.height > page.height + 0.5 ||
      block.sourceIds.some((id) => !page.items.some((item) => item.id === id))
    )
      throw new Error('원문 영역을 확인할 수 없습니다. PDF를 다시 열어 주세요.');
    if (block.kind !== 'sourceRegion' && !block.text.trim())
      throw new Error('빈 본문은 변환할 수 없습니다. 내용을 입력하거나 영역을 제외해 주세요.');
  }
  const ownerCounts = new Map<string, number>();
  for (const block of effective.blocks)
    for (const id of block.sourceIds) ownerCounts.set(id, (ownerCounts.get(id) ?? 0) + 1);
  const excludedIds = new Set(
    scopedReading.blocks
      .filter((block) => overrides[block.id]?.excluded)
      .flatMap((block) => block.sourceIds),
  );
  const hasUnrouted = scopedSource.pages.some((page) =>
    page.items.some((item) => !ownerCounts.has(item.id) && !excludedIds.has(item.id)),
  );
  if (hasUnrouted || [...ownerCounts.values()].some((count) => count > 1))
    throw new Error('내용의 누락이나 중복이 발견되었습니다. PDF를 다시 열어 주세요.');

  const output = await PDFDocument.create();
  output.registerFontkit(fontkit);
  const family = config.fontFamily === 'sans' ? 'NotoSans-Regular.ttf' : 'NotoSerif-Regular.ttf';
  const primary = await output.embedFont(await fontBytes(family), { subset: true });
  let korean: Awaited<ReturnType<typeof output.embedFont>> | undefined;
  const primarySet = new Set(primary.getCharacterSet());
  const allText = effective.blocks
    .filter((block) => block.kind !== 'sourceRegion')
    .map((block) => block.text)
    .join('');
  if ([...allText].some((char) => !primarySet.has(char.codePointAt(0)!) && !/\s/u.test(char))) {
    progress({ stage: 'laying-out', current: 0, total: 1, message: '글꼴 준비 중' });
    korean = await output.embedFont(await fontBytes('NotoSansKR-Regular.ttf'), { subset: true });
  }
  const koreanSet = new Set(korean?.getCharacterSet() ?? []);
  const fontFor = (char: string) =>
    primarySet.has(char.codePointAt(0)!)
      ? primary
      : koreanSet.has(char.codePointAt(0)!)
        ? korean!
        : primary;
  const renderOverrides: Overrides = { ...overrides };
  for (const block of effective.blocks) {
    if (
      block.kind !== 'sourceRegion' &&
      [...block.text].some(
        (char) =>
          !primarySet.has(char.codePointAt(0)!) &&
          !koreanSet.has(char.codePointAt(0)!) &&
          !/\s/u.test(char),
      )
    ) {
      if (overrides[block.id]?.text !== undefined)
        throw new Error(
          `${block.sourcePage}쪽 수정 내용에 지원하지 않는 문자가 있습니다. 다른 문자로 바꾸거나 원문 보존을 선택해 주세요.`,
        );
      block.kind = 'sourceRegion';
      block.reason = '출력 글꼴에 없는 문자를 원문 영역으로 보존';
      renderOverrides[block.id] = { ...overrides[block.id], kind: 'sourceRegion' };
    }
  }
  const runs = (text: string) => {
    const result: { text: string; font: typeof primary }[] = [];
    for (const char of text) {
      const font = fontFor(char);
      const last = result.at(-1);
      if (last?.font === font) last.text += char;
      else result.push({ text: char, font });
    }
    return result;
  };
  const measure = (text: string, size: number) =>
    runs(text).reduce((sum, run) => sum + run.font.widthOfTextAtSize(run.text, size), 0);
  progress({ stage: 'laying-out', current: 0, total: 1, message: '페이지 구성 중' });
  const layout = layoutDocument(effective, config, measure);
  const inBounds = layout.pages.every((page) =>
    page.placements.every(
      (placement) =>
        [placement.x, placement.y, placement.width, placement.height].every(Number.isFinite) &&
        placement.x >= config.marginLeftPt - 0.1 &&
        placement.y >= config.marginTopPt - 0.1 &&
        placement.x + placement.width <= config.pageWidthPt - config.marginRightPt + 0.1 &&
        placement.y + placement.height <= config.pageHeightPt - config.marginBottomPt + 0.1,
    ),
  );
  if (!layout.pages.length || !inBounds)
    throw new Error('페이지 바깥으로 벗어난 내용이 있습니다. 페이지 크기와 여백을 확인해 주세요.');
  const issues = collectCriticalIssues(scopedSource, scopedReading, renderOverrides, layout);
  const input = await openPdf(bytes, password);
  try {
    const footerFont = await output.embedFont(StandardFonts.Helvetica);
    const background = config.theme === 'warm' ? rgb(0.965, 0.941, 0.89) : rgb(1, 1, 1);
    const color = config.theme === 'warm' ? rgb(0.255, 0.204, 0.169) : rgb(0.12, 0.13, 0.14);
    for (let index = 0; index < layout.pages.length; index++) {
      const pageLayout = layout.pages[index];
      progress({
        stage: 'exporting',
        current: index + 1,
        total: layout.pages.length,
        message: `PDF ${index + 1} / ${layout.pages.length}쪽 생성 중`,
      });
      const page = output.addPage([config.pageWidthPt, config.pageHeightPt]);
      page.drawRectangle({
        x: 0,
        y: 0,
        width: config.pageWidthPt,
        height: config.pageHeightPt,
        color: background,
      });
      for (const placement of pageLayout.placements) {
        if (placement.type === 'text') {
          let x = placement.x;
          for (const run of runs(placement.text)) {
            page.drawText(run.text, {
              x,
              y: config.pageHeightPt - placement.y - placement.fontSize,
              size: placement.fontSize,
              font: run.font,
              color,
            });
            x += run.font.widthOfTextAtSize(run.text, placement.fontSize);
          }
        } else {
          const original = await input.getPage(placement.sourcePage);
          const scale = Math.max(
            0.1,
            Math.min(3, 2600 / Math.max(placement.sourceRect.width, placement.sourceRect.height)),
          );
          const canvas = await raster(original, scale, placement.sourceRect);
          const png = new Uint8Array(
            await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer(),
          );
          const image = await output.embedPng(png);
          page.drawImage(image, {
            x: placement.x,
            y: config.pageHeightPt - placement.y - placement.height,
            width: placement.width,
            height: placement.height,
          });
          canvas.width = 0;
          canvas.height = 0;
          original.cleanup();
        }
      }
      page.drawText(`${index + 1}${scope === 'preview' ? '  PREVIEW' : ''}`, {
        x: config.marginLeftPt,
        y: Math.max(5, config.marginBottomPt / 2 - 3),
        size: 7,
        font: footerFont,
        color,
      });
    }
    output.setTitle(`${scope === 'preview' ? '[PREVIEW] ' : ''}${source.name} - PDF Reflow`);
    output.setCreator(`PDF Reflow ${__APP_VERSION__}`);
    output.setProducer('pdf-lib + PDF.js');
    const readingPdf = await output.save();
    return { readingPdf, layout, scope, selectedPages: range, source, reading, issues };
  } finally {
    await input.loadingTask.destroy();
  }
}
