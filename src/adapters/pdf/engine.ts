import { getDocument, GlobalWorkerOptions, OPS, Util, version } from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { analyzeDocument, applyOverrides } from '../../core/analyze';
import { layoutDocument } from '../../core/layout';
import { attachStructure, markedContentAt } from './structure';
import { addNoteLinks } from './note-links';
import { textGeometry } from './text-geometry';
import { detectGraphicRegions } from './graphics';
import { graphicObjectBounds, joinGraphicObjects } from './graphic-objects';
import { readTextAlignments } from './alignment';
import { textSegments } from '../../core/text-alignment';
import { validateConfig } from '../../core/config';
import { colorTheme } from '../../core/color-themes';
import { flowingText } from '../../core/inline-content';
import { recolorMathPixels } from './math-raster';
import { collectCriticalIssues } from '../../core/issues';
import { buildEpub } from '../epub/package';
import type { EpubAssets } from '../epub/package';
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

/** Detect figures without allowing a merge to cross a flowing text paragraph. */
async function detectGraphics(page: PDFPageProxy, source: SourcePage): Promise<Rect[]> {
  const scale = Math.min(1, 1400 / Math.max(source.width, source.height));
  const canvas = await raster(page, scale);
  try {
    const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    const regions = detectGraphicRegions(pixels, canvas.width, canvas.height, scale, source);
    const objects = graphicObjectBounds(
      await page.getOperatorList(),
      OPS,
      page.getViewport({ scale: 1 }).transform,
      source,
    );
    return joinGraphicObjects(regions, objects, source);
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
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
  const alignments = await readTextAlignments(bytes);
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
      const content = await page.getTextContent({
        disableNormalization: true,
        includeMarkedContent: true,
      });
      const marked = markedContentAt(content.items);
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
      let directionalCharacters = 0;
      let characterCount = 0;
      let explicitSpace = false;
      for (let i = 0; i < content.items.length; i++) {
        const item = content.items[i];
        if (!('str' in item)) continue;
        if (!item.str.trim()) {
          if (/[ \t\u00a0]/u.test(item.str)) explicitSpace = true;
          if (item.hasEOL) explicitSpace = false;
          continue;
        }
        const transform = Util.transform(viewport.transform, item.transform);
        const style = content.styles[item.fontName];
        const ascent = style?.ascent ?? 0.85,
          descent = style?.descent ?? -0.2;
        const geometry = textGeometry(
          transform,
          item.width * scale,
          item.height * scale,
          ascent,
          descent,
        );
        const directional = item.dir === 'ttb' || item.dir === 'rtl';
        const metadata = marked.get(i);
        const mcid = metadata?.markedContentId?.match(/_mc(\d+)$/u)?.[1];
        const alignment =
          mcid === undefined ? undefined : alignments.get(number)?.get(Number(mcid));
        characterCount += item.str.trim().length;
        if (directional) directionalCharacters += item.str.trim().length;
        sourcePage.items.push({
          id: `p${number}-t${i}`,
          text: item.str,
          ...geometry.rect,
          fontSize: geometry.fontSize,
          ...(Math.abs(geometry.rotation) <= 0.5 ? { baselineY: transform[5] } : {}),
          ...(geometry.preserve || directional
            ? { preserve: true, rotation: geometry.rotation }
            : {}),
          fontName: `${style?.fontFamily ?? ''} ${item.fontName}`,
          hasEOL: item.hasEOL,
          ...(explicitSpace ? { spaceBefore: true } : {}),
          ...metadata,
          ...(alignment ? { alignment } : {}),
        });
        explicitSpace = false;
      }
      if (directionalCharacters > characterCount * 0.5)
        sourcePage.warnings.push(
          '세로쓰기·오른쪽에서 왼쪽 쓰기를 주로 사용하는 페이지는 원형으로 보존합니다.',
        );
      try {
        attachStructure(sourcePage, await page.getStructTree());
      } catch {
        // Optional tagging must never prevent extraction of visible page content.
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
  const selectedBlocks = new Set(scopedReading.blocks.map((block) => block.id));
  scopedReading.references = reading.references?.filter(
    (reference) =>
      selectedBlocks.has(reference.source.blockId) && selectedBlocks.has(reference.targetBlockId),
  );
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
    .map(flowingText)
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
      [...flowingText(block)].some(
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
    // Fontkit hides a discretionary hyphen even when the line break was selected.
    for (const char of text.replace(/\u00ad/gu, '-')) {
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
        (placement.decoration === 'runningHeader' || placement.decoration === 'runningFooter'
          ? placement.x >= 0 &&
            placement.y >= 0 &&
            placement.x + placement.width <= config.pageWidthPt + 0.1 &&
            placement.y + placement.height <= config.pageHeightPt + 0.1
          : placement.x >= config.marginLeftPt - 0.1 &&
            placement.y >= config.marginTopPt - 0.1 &&
            placement.x + placement.width <= config.pageWidthPt - config.marginRightPt + 0.1 &&
            placement.y + placement.height <= config.pageHeightPt - config.marginBottomPt + 0.1),
    ),
  );
  if (!layout.pages.length || !inBounds)
    throw new Error('페이지 바깥으로 벗어난 내용이 있습니다. 페이지 크기와 여백을 확인해 주세요.');
  const issues = collectCriticalIssues(scopedSource, scopedReading, renderOverrides, layout);
  const epubAssets: EpubAssets | undefined = scope === 'full' ? { images: new Map() } : undefined;
  const blocks = new Map(effective.blocks.map((block) => [block.id, block]));
  const input = await openPdf(bytes, password);
  const mathPages = new Map<number, { canvas: OffscreenCanvas; scale: number }>();
  try {
    const footerFont = await output.embedFont(StandardFonts.Helvetica);
    const theme = colorTheme(config.theme);
    const pdfColor = (hex: string) =>
      rgb(
        Number.parseInt(hex.slice(1, 3), 16) / 255,
        Number.parseInt(hex.slice(3, 5), 16) / 255,
        Number.parseInt(hex.slice(5, 7), 16) / 255,
      );
    const background = pdfColor(theme.background);
    const color = pdfColor(theme.foreground);
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
          for (const segment of textSegments(placement.text, placement.spacing)) {
            for (const run of runs(segment.text)) {
              page.drawText(run.text, {
                x,
                y: config.pageHeightPt - placement.y - placement.fontSize,
                size: placement.fontSize,
                font: run.font,
                color,
              });
              x += run.font.widthOfTextAtSize(run.text, placement.fontSize);
            }
            x += segment.extraAfter;
          }
        } else {
          const original = await input.getPage(placement.sourcePage);
          const scale = Math.max(
            0.1,
            Math.min(3, 2600 / Math.max(placement.sourceRect.width, placement.sourceRect.height)),
          );
          let canvas: OffscreenCanvas;
          if (placement.math) {
            let cached = mathPages.get(placement.sourcePage);
            if (!cached) {
              for (const entry of mathPages.values()) {
                entry.canvas.width = 0;
                entry.canvas.height = 0;
              }
              mathPages.clear();
              const bounds = original.getViewport({ scale: 1 });
              const detail = Math.min(6, 4600 / Math.max(bounds.width, bounds.height));
              cached = { canvas: await raster(original, detail), scale: detail };
              mathPages.set(placement.sourcePage, cached);
            }
            const rect = placement.sourceRect;
            canvas = new OffscreenCanvas(
              Math.max(1, Math.ceil(rect.width * cached.scale)),
              Math.max(1, Math.ceil(rect.height * cached.scale)),
            );
            const context = canvas.getContext('2d', { willReadFrequently: true })!;
            context.drawImage(
              cached.canvas,
              rect.x * cached.scale,
              rect.y * cached.scale,
              rect.width * cached.scale,
              rect.height * cached.scale,
              0,
              0,
              canvas.width,
              canvas.height,
            );
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
            if (recolorMathPixels(pixels.data, canvas.width, canvas.height, theme.foreground))
              context.putImageData(pixels, 0, 0);
          } else canvas = await raster(original, scale, placement.sourceRect);
          const png = new Uint8Array(
            await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer(),
          );
          if (epubAssets && !placement.decoration) {
            const block = blocks.get(placement.blockId)!;
            const inline =
              block.kind !== 'sourceRegion' &&
              block.inlineMath?.find(
                ({ rect }) =>
                  rect.x === placement.sourceRect.x &&
                  rect.y === placement.sourceRect.y &&
                  rect.width === placement.sourceRect.width &&
                  rect.height === placement.sourceRect.height,
              );
            const key = inline ? `${block.id}:math:${inline.start}` : block.id;
            epubAssets.images.set(key, {
              path: `images/region-${epubAssets.images.size + 1}.png`,
              bytes: png,
              width: placement.sourceRect.width,
              height: placement.sourceRect.height,
              ...(inline ? { baseline: inline.baselineY - inline.rect.y } : {}),
            });
          }
          const image = await output.embedPng(png);
          page.drawImage(image, {
            x: placement.x,
            y: config.pageHeightPt - placement.y - placement.height,
            width: placement.width,
            height: placement.height,
          });
          canvas.width = 0;
          canvas.height = 0;
          if (!placement.math) original.cleanup();
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
    addNoteLinks(output, effective, layout, measure);
    output.setTitle(`${scope === 'preview' ? '[PREVIEW] ' : ''}${source.name} - PDF Reflow`);
    output.setCreator(`PDF Reflow ${__APP_VERSION__}`);
    output.setProducer('pdf-lib + PDF.js');
    const readingPdf = await output.save();
    let readingEpub: Uint8Array | undefined;
    if (epubAssets) {
      progress({ stage: 'exporting', current: 0, total: 1, message: 'EPUB 생성 중' });
      epubAssets.fonts = [
        { path: `fonts/${family}`, bytes: await fontBytes(family), family: 'primary' },
        ...(korean
          ? [
              {
                path: 'fonts/NotoSansKR-Regular.ttf',
                bytes: await fontBytes('NotoSansKR-Regular.ttf'),
                family: 'korean' as const,
              },
            ]
          : []),
      ];
      epubAssets.licenses = [
        { path: 'META-INF/licenses/OFL-Noto.txt', bytes: await fontBytes('OFL-Noto.txt') },
        ...(korean
          ? [
              {
                path: 'META-INF/licenses/OFL-NotoKR.txt',
                bytes: await fontBytes('OFL-NotoKR.txt'),
              },
            ]
          : []),
      ];
      readingEpub = buildEpub(scopedSource, effective, config, epubAssets);
    }
    return {
      readingPdf,
      readingEpub,
      layout,
      scope,
      selectedPages: range,
      source,
      reading,
      issues,
    };
  } finally {
    for (const entry of mathPages.values()) {
      entry.canvas.width = 0;
      entry.canvas.height = 0;
    }
    await input.loadingTask.destroy();
  }
}
