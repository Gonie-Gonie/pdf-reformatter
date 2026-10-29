import { useEffect, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { ChevronLeft, ChevronRight, Minus, Plus, Maximize2 } from 'lucide-react';
import { getSourcePassword } from '../adapters/pdf/client';
import type { Rect } from '../core/model';
import './PdfViewer.css';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

interface Props {
  data: Uint8Array | null;
  page: number;
  onPageChange?: (page: number) => void;
  label: string;
  highlight?: Rect | null;
}

interface RenderedView {
  pdf: PDFDocumentProxy;
  page: number;
  width: number;
  zoom: number;
}

export function PdfViewer({ data, page, onPageChange, label, highlight }: Props) {
  const [loaded, setLoaded] = useState<{ data: Uint8Array; pdf: PDFDocumentProxy } | null>(null);
  const [error, setError] = useState('');
  const [width, setWidth] = useState(420);
  const [zoom, setZoom] = useState(1);
  const [geometry, setGeometry] = useState({ width: 1, height: 1, scale: 1 });
  const [rendered, setRendered] = useState<RenderedView | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const activeRender = useRef<RenderTask | null>(null);
  // A replacement byte buffer must never display the previous document, even for one frame.
  const pdf = loaded?.data === data ? loaded.pdf : null;
  const current = Math.min(Math.max(1, page), pdf?.numPages ?? 1);
  const ready =
    rendered?.pdf === pdf &&
    rendered?.page === current &&
    rendered?.width === width &&
    rendered?.zoom === zoom;

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) =>
      setWidth(Math.max(140, entries[0].contentRect.width - 36)),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setLoaded(null);
    setError('');
    if (!data) return;
    let active = true;
    const base = import.meta.env.BASE_URL;
    const task = getDocument({
      data: data.slice(),
      password: getSourcePassword(),
      useSystemFonts: false,
      cMapUrl: `${base}pdfjs/cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${base}pdfjs/standard_fonts/`,
      wasmUrl: `${base}pdfjs/wasm/`,
    });
    void task.promise
      .then((document) => {
        if (active) setLoaded({ data, pdf: document });
      })
      .catch((caught) => {
        if (active)
          setError(caught instanceof Error ? caught.message : 'PDF를 표시할 수 없습니다.');
      });
    return () => {
      active = false;
      void task.destroy().catch(() => {
        /* Loading was already cancelled. */
      });
    };
  }, [data]);

  useEffect(() => {
    if (!pdf || !canvas.current) return;
    let active = true;
    let renderTask: RenderTask | undefined;
    const previous = activeRender.current;
    previous?.cancel();
    setError('');
    void (async () => {
      // PDF.js forbids concurrent renders into the same canvas during rapid page/size changes.
      if (previous)
        await previous.promise.catch(() => {
          /* Cancellation is expected. */
        });
      if (!active) return;
      const original = await pdf.getPage(current);
      if (!active || !canvas.current) return;
      const viewport = original.getViewport({ scale: 1 });
      const scale = Math.min(width / viewport.width, 1.5) * zoom;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const display = original.getViewport({ scale });
      const element = canvas.current;
      element.width = Math.ceil(display.width * dpr);
      element.height = Math.ceil(display.height * dpr);
      element.style.width = `${display.width}px`;
      element.style.height = `${display.height}px`;
      setGeometry({ width: display.width, height: display.height, scale });
      renderTask = original.render({
        canvas: element,
        viewport: display,
        transform: [dpr, 0, 0, dpr, 0, 0],
      });
      activeRender.current = renderTask;
      await renderTask.promise;
      if (active) setRendered({ pdf, page: current, width, zoom });
    })()
      .catch((caught: unknown) => {
        if (active && !(caught instanceof Error && caught.name === 'RenderingCancelledException'))
          setError(caught instanceof Error ? caught.message : '페이지 표시 오류');
      })
      .finally(() => {
        if (activeRender.current === renderTask) activeRender.current = null;
      });
    return () => {
      active = false;
      renderTask?.cancel();
    };
  }, [pdf, current, width, zoom]);

  return (
    <section
      className="pdf-viewer"
      aria-label={`${label} PDF 뷰어`}
      aria-busy={Boolean(data && !ready && !error)}
    >
      <div className="pdf-toolbar">
        <span className="pdf-label">{label}</span>
        <div className="pdf-page-nav">
          <button
            type="button"
            aria-label={`${label} 이전 페이지`}
            disabled={!pdf || current <= 1}
            onClick={() => onPageChange?.(current - 1)}
          >
            <ChevronLeft size={16} />
          </button>
          <input
            aria-label={`${label} 페이지`}
            type="number"
            min="1"
            max={pdf?.numPages ?? 1}
            value={current}
            disabled={!pdf}
            onChange={(event) =>
              onPageChange?.(
                Math.max(1, Math.min(pdf?.numPages ?? 1, Number(event.target.value) || 1)),
              )
            }
          />
          <span>/ {pdf?.numPages ?? '—'}</span>
          <button
            type="button"
            aria-label={`${label} 다음 페이지`}
            disabled={!pdf || current >= pdf.numPages}
            onClick={() => onPageChange?.(current + 1)}
          >
            <ChevronRight size={16} />
          </button>
        </div>
        <div className="pdf-zoom-nav">
          <button
            type="button"
            aria-label={`${label} 축소`}
            disabled={!pdf || zoom <= 0.5}
            onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))}
          >
            <Minus size={15} />
          </button>
          <button
            type="button"
            aria-label={`${label} 화면에 맞추기`}
            disabled={!pdf}
            onClick={() => setZoom(1)}
            title="화면에 맞추기"
          >
            <Maximize2 size={14} />
          </button>
          <button
            type="button"
            aria-label={`${label} 확대`}
            disabled={!pdf || zoom >= 3}
            onClick={() => setZoom((value) => Math.min(3, value + 0.25))}
          >
            <Plus size={15} />
          </button>
        </div>
      </div>
      <div className="pdf-canvas-scroll" ref={container}>
        {error && (
          <p role="alert" className="pdf-error">
            {error}
          </p>
        )}
        {data && !ready && !error && (
          <p role="status" className="pdf-empty">
            {pdf ? '페이지를 그리는 중입니다…' : 'PDF를 불러오는 중입니다…'}
          </p>
        )}
        {data ? (
          <div
            className="pdf-paper"
            hidden={!ready || Boolean(error)}
            style={{ width: geometry.width, height: geometry.height }}
          >
            <canvas ref={canvas} aria-label={`${label} ${current}쪽`} />
            {ready && highlight && (
              <div
                className="pdf-highlight"
                style={{
                  left: highlight.x * geometry.scale,
                  top: highlight.y * geometry.scale,
                  width: highlight.width * geometry.scale,
                  height: highlight.height * geometry.scale,
                }}
              />
            )}
          </div>
        ) : (
          <p className="pdf-empty">PDF를 열면 페이지를 표시합니다.</p>
        )}
      </div>
    </section>
  );
}
