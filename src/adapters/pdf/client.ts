import type {
  ConversionResult,
  LayoutConfig,
  Overrides,
  Progress,
  ReadingDocument,
  SourceDocument,
} from '../../core/model';
let sourceBytes: Uint8Array | null = null;
let sourcePassword: string | undefined;
let worker: Worker | null = null;
let rejectActive: ((reason: Error) => void) | null = null;
let requestId = 0;
let lifecycle = 0;
export function cancelJob(): void {
  lifecycle++;
  worker?.terminate();
  worker = null;
  rejectActive?.(new DOMException('작업을 취소했습니다. 다시 변환할 수 있습니다.', 'AbortError'));
  rejectActive = null;
}
export function clearDocument(): void {
  cancelJob();
  sourceBytes = null;
  sourcePassword = undefined;
}
export function getSourceBytes(): Uint8Array | null {
  return sourceBytes;
}
export function getSourcePassword(): string | undefined {
  return sourcePassword;
}
function runJob<T>(
  payload: Record<string, unknown>,
  onProgress: (p: Progress) => void,
): Promise<T> {
  cancelJob();
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    rejectActive = reject;
    worker = new Worker(new URL('../../workers/pdf.worker.ts', import.meta.url), {
      type: 'module',
    });
    const active = worker;
    const cleanup = () => {
      active.terminate();
      if (worker === active) {
        worker = null;
        rejectActive = null;
      }
    };
    active.onmessage = (event) => {
      const message = event.data;
      if (message.id !== id) return;
      if (message.type === 'progress') onProgress(message.value);
      else if (message.type === 'result') {
        cleanup();
        resolve(message.value as T);
      } else if (message.type === 'error') {
        cleanup();
        const error = new Error(message.message);
        error.name = message.name;
        reject(error);
      }
    };
    active.onerror = (event) => {
      cleanup();
      reject(
        new Error(
          event.message ||
            'PDF 작업 Worker를 실행할 수 없습니다. 페이지를 새로 열고 다시 시도해 주세요.',
        ),
      );
    };
    const bytes = payload.bytes as Uint8Array;
    active.postMessage({ ...payload, id }, [bytes.buffer as ArrayBuffer]);
  });
}
export async function analyzePdf(
  file: File,
  onProgress: (p: Progress) => void,
  password?: string,
): Promise<{ source: SourceDocument; reading: ReadingDocument }> {
  cancelJob();
  const revision = lifecycle;
  if (!file.size) throw new Error('빈 파일입니다. PDF 파일을 선택해 주세요.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (revision !== lifecycle) throw new DOMException('작업을 취소했습니다.', 'AbortError');
  if (!new TextDecoder('latin1').decode(bytes.subarray(0, 1024)).includes('%PDF-'))
    throw new Error('PDF 형식이 아닙니다. 파일 확장자와 내용을 확인해 주세요.');
  const result = await runJob<{ source: SourceDocument; reading: ReadingDocument }>(
    { type: 'analyze', bytes: bytes.slice(), name: file.name, password },
    onProgress,
  );
  sourceBytes = bytes;
  sourcePassword = password;
  return result;
}
export function convertPdf(
  source: SourceDocument,
  reading: ReadingDocument,
  config: LayoutConfig,
  overrides: Overrides,
  onProgress: (p: Progress) => void,
  pageRange?: number[],
): Promise<ConversionResult> {
  if (!sourceBytes) return Promise.reject(new Error('원본 PDF를 먼저 열어 주세요.'));
  if (source.hash !== reading.sourceHash)
    return Promise.reject(new Error('분석 결과와 원본 PDF의 해시가 일치하지 않습니다.'));
  return runJob<ConversionResult>(
    {
      type: 'convert',
      bytes: sourceBytes.slice(),
      source,
      reading,
      config,
      overrides,
      range: pageRange,
      password: sourcePassword,
    },
    onProgress,
  );
}
