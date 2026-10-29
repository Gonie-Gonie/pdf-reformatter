import { getDocument, GlobalWorkerOptions, Util, version } from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { analyzeDocument, applyOverrides } from '../../core/analyze';
import { layoutDocument } from '../../core/layout';
import { validateConfig } from '../../core/config';
import type {
  ConversionResult,
  LayoutConfig,
  Overrides,
  Progress,
  ReadingDocument,
  Rect,
  SourceDocument,
  SourcePage,
  VerificationReport,
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
): Promise<{ source: SourceDocument; reading: ReadingDocument }> {
  if (typeof OffscreenCanvas === 'undefined')
    throw new Error(
      '이 브라우저는 OffscreenCanvas를 지원하지 않습니다. 최신 Chrome 또는 Edge에서 열어 주세요.',
    );
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
    for (let number = 1; number <= pdf.numPages; number++) {
      progress({
        stage: 'extracting',
        current: number,
        total: pdf.numPages,
        message: `원문 ${number} / ${pdf.numPages}쪽 분석 중`,
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
      if (annotations.length)
        sourcePage.warnings.push(
          '주석·양식·링크는 원형 보존 영역의 보이는 모습만 반영하며 상호작용은 이전하지 않습니다.',
        );
      sourcePage.graphicRegions = sourcePage.items.length
        ? await detectGraphics(page, sourcePage)
        : [];
      source.pages.push(sourcePage);
      page.cleanup();
    }
    progress({
      stage: 'analyzing',
      current: source.pageCount,
      total: source.pageCount,
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
const limitations = [
  '규칙 기반 분석입니다. 복잡한 다단 문서·표·수식의 읽기 순서는 원문과 대조해 검토해야 합니다.',
  '원문 보존 영역은 최대 3배 해상도의 이미지입니다. 해당 영역의 텍스트 선택·검색 및 벡터 특성은 유지되지 않습니다.',
  'OCR, 원문 링크·책갈피·양식의 상호작용 이전, 원문의 전자서명 보존은 지원하지 않습니다.',
  '검증은 원문 텍스트 항목의 처리 경로와 배치를 확인합니다. PDF에서 추출되지 않은 의미나 원본과의 시각적 동등성을 보증하지 않습니다.',
  '영역 자르기는 보안 삭제 기능이 아닙니다. 원문 대조 합본에는 원문 페이지의 보이는 내용 전체가 포함됩니다.',
];

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
  const range = selectedPages ?? source.pages.map((p) => p.number);
  if (
    !range.length ||
    new Set(range).size !== range.length ||
    range.some((n) => !Number.isInteger(n) || n < 1 || n > source.pageCount)
  )
    throw new Error('미리보기 페이지 범위가 올바르지 않습니다.');
  const scope = selectedPages ? ('preview' as const) : ('full' as const);
  const effective = applyOverrides(reading, overrides);
  effective.blocks = effective.blocks.filter((b) => range.includes(b.sourcePage));
  if (!effective.blocks.length)
    throw new Error('변환할 블록이 없습니다. 제외 설정을 확인해 주세요.');
  for (const block of effective.blocks) {
    const page = source.pages.find((p) => p.number === block.sourcePage);
    const r = block.rect;
    if (
      !page ||
      ![r.x, r.y, r.width, r.height].every(Number.isFinite) ||
      r.width <= 0 ||
      r.height <= 0 ||
      r.x < -0.1 ||
      r.y < -0.1 ||
      r.x + r.width > page.width + 0.5 ||
      r.y + r.height > page.height + 0.5 ||
      block.sourceIds.some((id) => !page.items.some((item) => item.id === id))
    ) {
      throw new Error(
        '원문과 작업 파일의 영역 정보가 일치하지 않습니다. 원본 PDF를 다시 분석해 주세요.',
      );
    }
    if (block.kind !== 'sourceRegion' && !block.text.trim())
      throw new Error(
        '본문을 비우는 대신 블록 제외를 선택해 주세요. 빈 본문은 누락 방지를 위해 변환하지 않습니다.',
      );
  }
  const output = await PDFDocument.create();
  output.registerFontkit(fontkit);
  const family = config.fontFamily === 'sans' ? 'NotoSans-Regular.ttf' : 'NotoSerif-Regular.ttf';
  const primary = await output.embedFont(await fontBytes(family), { subset: true });
  let korean: Awaited<ReturnType<typeof output.embedFont>> | undefined;
  const primarySet = new Set(primary.getCharacterSet());
  const allText = effective.blocks
    .filter((b) => b.kind !== 'sourceRegion')
    .map((b) => b.text)
    .join('');
  if ([...allText].some((c) => !primarySet.has(c.codePointAt(0)!) && !/\s/u.test(c))) {
    progress({
      stage: 'laying-out',
      current: 0,
      total: 1,
      message: '한글·다국어 대체 글꼴 준비 중',
    });
    korean = await output.embedFont(await fontBytes('NotoSansKR-Regular.ttf'), { subset: true });
  }
  const koreanSet = new Set(korean?.getCharacterSet() ?? []);
  const fontFor = (char: string) =>
    primarySet.has(char.codePointAt(0)!)
      ? primary
      : koreanSet.has(char.codePointAt(0)!)
        ? korean!
        : primary;
  const glyphWarnings: string[] = [];
  for (const block of effective.blocks) {
    if (
      block.kind !== 'sourceRegion' &&
      [...block.text].some(
        (c) =>
          !primarySet.has(c.codePointAt(0)!) && !koreanSet.has(c.codePointAt(0)!) && !/\s/u.test(c),
      )
    ) {
      if (overrides[block.id]?.text !== undefined)
        throw new Error(
          `${block.sourcePage}쪽에서 수정한 본문에 지원하지 않는 문자가 있습니다. 다른 문자로 수정하거나 해당 블록의 원문 보존을 선택해 주세요.`,
        );
      block.kind = 'sourceRegion';
      block.reason = '출력 글꼴에 없는 문자를 포함해 원문 영역으로 보존';
      glyphWarnings.push(
        `${block.sourcePage}쪽: 지원하지 않는 글리프가 있는 블록을 원문 이미지로 보존했습니다.`,
      );
    }
  }
  const runs = (text: string) => {
    const result: { text: string; font: typeof primary }[] = [];
    for (const char of text) {
      const font = fontFor(char),
        last = result.at(-1);
      if (last?.font === font) last.text += char;
      else result.push({ text: char, font });
    }
    return result;
  };
  const measure = (text: string, size: number) =>
    runs(text).reduce((sum, r) => sum + r.font.widthOfTextAtSize(r.text, size), 0);
  progress({
    stage: 'laying-out',
    current: 0,
    total: 1,
    message: '실제 글꼴 폭으로 줄바꿈과 페이지 나눔 계산 중',
  });
  const layout = layoutDocument(effective, config, measure);
  const input = await openPdf(bytes, password);
  const footerFont = await output.embedFont(StandardFonts.Helvetica);
  const background = config.theme === 'warm' ? rgb(0.965, 0.941, 0.89) : rgb(1, 1, 1);
  const color = config.theme === 'warm' ? rgb(0.255, 0.204, 0.169) : rgb(0.12, 0.13, 0.14);
  try {
    for (let index = 0; index < layout.pages.length; index++) {
      const pageLayout = layout.pages[index];
      progress({
        stage: 'exporting',
        current: index + 1,
        total: layout.pages.length,
        message: `읽기본 ${index + 1} / ${layout.pages.length}쪽 생성 중`,
      });
      const page = output.addPage([config.pageWidthPt, config.pageHeightPt]);
      page.drawRectangle({
        x: 0,
        y: 0,
        width: config.pageWidthPt,
        height: config.pageHeightPt,
        color: background,
      });
      for (const p of pageLayout.placements) {
        if (p.type === 'text') {
          let x = p.x;
          for (const run of runs(p.text)) {
            page.drawText(run.text, {
              x,
              y: config.pageHeightPt - p.y - p.fontSize,
              size: p.fontSize,
              font: run.font,
              color,
            });
            x += run.font.widthOfTextAtSize(run.text, p.fontSize);
          }
        } else {
          const original = await input.getPage(p.sourcePage);
          const scale = Math.max(
            0.1,
            Math.min(3, 2600 / Math.max(p.sourceRect.width, p.sourceRect.height)),
          );
          const canvas = await raster(original, scale, p.sourceRect);
          const png = new Uint8Array(
            await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer(),
          );
          const image = await output.embedPng(png);
          page.drawImage(image, {
            x: p.x,
            y: config.pageHeightPt - p.y - p.height,
            width: p.width,
            height: p.height,
          });
          canvas.width = 0;
          canvas.height = 0;
          original.cleanup();
        }
      }
      page.drawText(
        `${index + 1}  /  source ${pageLayout.sourcePages.join(', ')}${scope === 'preview' ? '  PREVIEW' : ''}`,
        {
          x: config.marginLeftPt,
          y: Math.max(5, config.marginBottomPt / 2 - 3),
          size: 7,
          font: footerFont,
          color,
        },
      );
    }
    output.setTitle(`${scope === 'preview' ? '[PREVIEW] ' : ''}${source.name} - PDF Reflow`);
    output.setCreator(`PDF Reflow ${__APP_VERSION__}`);
    output.setProducer('pdf-lib + PDF.js');
    const readingPdf = await output.save();
    progress({
      stage: 'verifying',
      current: 0,
      total: layout.pages.length,
      message: '전체 출력 페이지를 다시 열어 렌더링 검증 중',
    });
    const reopened = await openPdf(readingPdf);
    try {
      for (let n = 1; n <= reopened.numPages; n++) {
        const page = await reopened.getPage(n),
          canvas = await raster(page, 0.35);
        canvas.width = 0;
        canvas.height = 0;
        page.cleanup();
        progress({
          stage: 'verifying',
          current: n,
          total: reopened.numPages,
          message: `출력 ${n} / ${reopened.numPages}쪽 렌더링 확인`,
        });
      }
    } finally {
      await reopened.loadingTask.destroy();
    }
    const sourceIds = source.pages
      .filter((p) => range.includes(p.number))
      .flatMap((p) => p.items.map((i) => i.id));
    const ownerCounts = new Map<string, number>();
    for (const block of effective.blocks)
      for (const id of block.sourceIds) ownerCounts.set(id, (ownerCounts.get(id) ?? 0) + 1);
    const excludedIds = new Set(
      reading.blocks.filter((b) => overrides[b.id]?.excluded).flatMap((b) => b.sourceIds),
    );
    const unrouted = sourceIds.filter((id) => !ownerCounts.has(id) && !excludedIds.has(id));
    const duplicated = [...ownerCounts].filter(([, count]) => count > 1);
    const inBounds = layout.pages.every((p) =>
      p.placements.every(
        (b) =>
          b.x >= config.marginLeftPt - 0.1 &&
          b.y >= config.marginTopPt - 0.1 &&
          b.x + b.width <= config.pageWidthPt - config.marginRightPt + 0.1 &&
          b.y + b.height <= config.pageHeightPt - config.marginBottomPt + 0.1,
      ),
    );
    const report: VerificationReport = {
      schemaVersion: 1,
      appVersion: __APP_VERSION__,
      createdAt: new Date().toISOString(),
      sourceHash: source.hash,
      sourceName: source.name,
      sourcePages: source.pageCount,
      outputPages: layout.pages.length,
      scope,
      selectedPages: range,
      config,
      blockCount: effective.blocks.length,
      reflowedBlocks: effective.blocks.filter((b) => b.kind !== 'sourceRegion').length,
      preservedBlocks: effective.blocks.filter((b) => b.kind === 'sourceRegion').length,
      excludedBlocks: reading.blocks.filter(
        (b) => range.includes(b.sourcePage) && overrides[b.id]?.excluded,
      ).length,
      warnings: [
        ...new Set([
          ...source.pages.flatMap((p) => p.warnings.map((w) => `${p.number}쪽: ${w}`)),
          ...effective.warnings,
          ...layout.warnings,
          ...glyphWarnings,
          ...(Object.values(overrides).some((o) => o.text !== undefined)
            ? ['사용자가 수정한 텍스트가 포함되어 원문 문자열과 다를 수 있습니다.']
            : []),
        ]),
      ],
      checks: [
        {
          name: '원문 처리 경로',
          passed: !unrouted.length,
          detail: `${sourceIds.length}개 추출 항목 중 미처리 ${unrouted.length}개 (사용자 제외는 별도 기록)`,
        },
        {
          name: '중복 소유 검사',
          passed: !duplicated.length,
          detail: `여러 블록에 중복 배정된 항목 ${duplicated.length}개`,
        },
        {
          name: '출력 경계 검사',
          passed: inBounds,
          detail: '모든 배치 상자가 본문 가용 영역 안에 있는지 검사',
        },
        {
          name: '전체 렌더링 검사',
          passed: true,
          detail: `${layout.pages.length}개 출력 페이지를 PDF.js로 다시 렌더링`,
        },
        {
          name: '변환 범위',
          passed: scope === 'full',
          detail:
            scope === 'full'
              ? `전체 원문 ${source.pageCount}쪽 처리`
              : `미리보기: ${range.join(', ')}쪽만 처리`,
        },
      ],
      blocks: effective.blocks.map((block) => ({
        id: block.id,
        sourcePage: block.sourcePage,
        kind: block.kind,
        route: block.kind === 'sourceRegion' ? 'raster-preserved' : 'reflowed',
        outputPages: layout.pages
          .filter((p) => p.placements.some((x) => x.blockId === block.id))
          .map((p) => p.number),
        reason: block.reason,
      })),
      limitations,
    };
    if (unrouted.length || duplicated.length || !inBounds)
      throw new Error(
        '출력 검증에서 누락·중복 또는 배치 경계 오류를 발견했습니다. 설정이나 원문 보존 보정을 확인해 주세요.',
      );
    progress({
      stage: 'exporting',
      current: 0,
      total: range.length,
      message: '원문 대조 합본 생성 중',
    });
    const comparison = await PDFDocument.create();
    const copied = await comparison.copyPages(output, output.getPageIndices());
    const added = new Set<number>();
    const addOriginal = async (number: number) => {
      added.add(number);
      const original = await input.getPage(number),
        vp = original.getViewport({ scale: 1 });
      const canvas = await raster(original, Math.min(1.6, 2200 / Math.max(vp.width, vp.height)));
      const image = await comparison.embedPng(
        new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer()),
      );
      comparison
        .addPage([vp.width, vp.height])
        .drawImage(image, { x: 0, y: 0, width: vp.width, height: vp.height });
      canvas.width = 0;
      canvas.height = 0;
      original.cleanup();
      progress({
        stage: 'exporting',
        current: added.size,
        total: range.length,
        message: `원문 대조 ${added.size} / ${range.length}쪽 추가`,
      });
    };
    // Safe visual originals; PDF actions, scripts, and attachments are never copied.
    for (let i = 0; i < copied.length; i++) {
      comparison.addPage(copied[i]);
      for (const number of layout.pages[i].sourcePages)
        if (!added.has(number)) await addOriginal(number);
    }
    for (const number of range.filter((n) => !added.has(n))) await addOriginal(number);
    comparison.setTitle(
      `${scope === 'preview' ? '[PREVIEW] ' : ''}${source.name} - Reading and source comparison`,
    );
    const comparisonPdf = await comparison.save();
    const comparisonCheck = await openPdf(comparisonPdf);
    try {
      for (let n = 1; n <= comparisonCheck.numPages; n++) {
        const page = await comparisonCheck.getPage(n),
          canvas = await raster(page, 0.25);
        canvas.width = 0;
        canvas.height = 0;
        page.cleanup();
        progress({
          stage: 'verifying',
          current: n,
          total: comparisonCheck.numPages,
          message: `대조 합본 ${n} / ${comparisonCheck.numPages}쪽 렌더링 확인`,
        });
      }
      report.checks.push({
        name: '대조 합본 렌더링 검사',
        passed: true,
        detail: `${comparisonCheck.numPages}개 합본 페이지를 다시 렌더링. 원문 ${range.length}쪽의 보이는 모습 포함`,
      });
    } finally {
      await comparisonCheck.loadingTask.destroy();
    }
    report.blocks.push(
      ...reading.blocks
        .filter((block) => range.includes(block.sourcePage) && overrides[block.id]?.excluded)
        .map((block) => ({
          id: block.id,
          sourcePage: block.sourcePage,
          kind: block.kind,
          route: 'excluded',
          outputPages: [],
          reason: '사용자가 명시적으로 제외한 원문 블록',
        })),
    );
    return { readingPdf, comparisonPdf, layout, report };
  } finally {
    await input.loadingTask.destroy();
  }
}
