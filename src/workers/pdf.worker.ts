import { extractPdf, exportPdf } from '../adapters/pdf/engine';
import type { LayoutConfig, Overrides, ReadingDocument, SourceDocument } from '../core/model';
interface Request {
  id: number;
  type: 'analyze' | 'convert';
  bytes: Uint8Array;
  name: string;
  password?: string;
  pageLimit?: number;
  source: SourceDocument;
  reading: ReadingDocument;
  config: LayoutConfig;
  overrides: Overrides;
  range?: number[];
}
self.onmessage = async (event: MessageEvent<Request>) => {
  const r = event.data;
  const progress = (value: unknown) => self.postMessage({ id: r.id, type: 'progress', value });
  try {
    if (r.type === 'analyze') {
      const value = await extractPdf(r.bytes, r.name, progress, r.password, r.pageLimit);
      self.postMessage({ id: r.id, type: 'result', value });
    } else {
      const value = await exportPdf(
        r.bytes,
        r.source,
        r.reading,
        r.config,
        r.overrides,
        progress,
        r.range,
        r.password,
      );
      self.postMessage(
        { id: r.id, type: 'result', value },
        {
          transfer: [value.readingPdf.buffer as ArrayBuffer],
        },
      );
    }
  } catch (error) {
    const caught = error instanceof Error ? error : new Error(String(error));
    if (import.meta.env.DEV) console.error(caught.stack);
    const message =
      caught.name === 'PasswordException'
        ? 'PDF 암호가 필요하거나 비밀번호가 올바르지 않습니다.'
        : caught.name === 'InvalidPDFException'
          ? 'PDF가 손상되었거나 지원하지 않는 구조입니다. 다른 PDF로 다시 시도해 주세요.'
          : caught.message;
    self.postMessage({ id: r.id, type: 'error', name: caught.name, message });
  }
};
