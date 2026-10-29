import { useEffect, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { ChevronLeft, ChevronRight, Minus, Plus, Maximize2 } from 'lucide-react';
import { getSourcePassword } from '../adapters/pdf/client';
import type { Rect } from '../core/model';
import type { PageAnchor } from '../core/navigation';
import './PdfViewer.css';
GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
interface Props {
  data: Uint8Array | null;
  page: number;
  onPageChange?: (page: number) => void;
  label: string;
  highlight?: Rect | null;
  scrollTarget?: PageAnchor | null;
}
interface RenderedPage {
  pdf: PDFDocumentProxy;
  page: number;
  availableWidth: number;
  zoom: number;
  width: number;
  height: number;
  scale: number;
}
export function PdfViewer({ data, page, onPageChange, label, highlight, scrollTarget }: Props) {
  const [loaded, setLoaded] = useState<{ data: Uint8Array; pdf: PDFDocumentProxy } | null>(null);
  const [error, setError] = useState('');
  const [availableWidth, setAvailableWidth] = useState(420),
    [zoom, setZoom] = useState(1);
  const [rendered, setRendered] = useState<RenderedPage | null>(null);
  const frame = useRef<HTMLElement>(null),
    scroll = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null);
  const activeRender = useRef<RenderTask | null>(null);
  const lastScroll = useRef<{
    pdf: PDFDocumentProxy;
    page: number;
    target: PageAnchor | null;
  } | null>(null);
  const pdf = loaded?.data === data ? loaded.pdf : null;
  const current = Math.min(Math.max(1, page), pdf?.numPages ?? 1);
  const currentPage = rendered?.pdf === pdf && rendered?.page === current ? rendered : null;
  const ready = Boolean(
    currentPage && currentPage.availableWidth === availableWidth && currentPage.zoom === zoom,
  );
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    let pending = 0;
    const measure = () => {
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(() => {
        const viewport = scroll.current;
        if (!viewport) return;
        const style = getComputedStyle(viewport);
        const next = Math.max(
          100,
          Math.floor(
            viewport.clientWidth -
              parseFloat(style.paddingLeft) -
              parseFloat(style.paddingRight) -
              2,
          ),
        );
        setAvailableWidth((previous) => (Math.abs(previous - next) >= 2 ? next : previous));
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(pending);
    };
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
        if (active) setError(caught instanceof Error ? caught.message : 'PDF 표시 오류');
      });
    return () => {
      active = false;
      activeRender.current?.cancel();
      void task.destroy().catch(() => {});
    };
  }, [data]);
  useEffect(() => {
    if (!pdf) return;
    let active = true;
    let task: RenderTask | undefined;
    const previous = activeRender.current;
    previous?.cancel();
    setError('');
    void (async () => {
      if (previous) await previous.promise.catch(() => {});
      if (!active) return;
      const original = await pdf.getPage(current);
      if (!active) return;
      const viewport = original.getViewport({ scale: 1 });
      const scale = Math.min(availableWidth / viewport.width, 1.5) * zoom;
      const display = original.getViewport({ scale });
      const dpr = Math.min(
        window.devicePixelRatio || 1,
        2,
        Math.sqrt(12_000_000 / Math.max(1, display.width * display.height)),
        16_000 / Math.max(display.width, display.height),
      );
      const buffer = document.createElement('canvas');
      buffer.width = Math.max(1, Math.ceil(display.width * dpr));
      buffer.height = Math.max(1, Math.ceil(display.height * dpr));
      task = original.render({
        canvas: buffer,
        viewport: display,
        transform: [dpr, 0, 0, dpr, 0, 0],
      });
      activeRender.current = task;
      try {
        await task.promise;
        const target = canvas.current;
        if (!active || !target) return;
        target.width = buffer.width;
        target.height = buffer.height;
        target.getContext('2d')!.drawImage(buffer, 0, 0);
        setRendered({
          pdf,
          page: current,
          availableWidth,
          zoom,
          width: display.width,
          height: display.height,
          scale,
        });
      } finally {
        buffer.width = 0;
        buffer.height = 0;
      }
    })()
      .catch((caught) => {
        if (active && !(caught instanceof Error && caught.name === 'RenderingCancelledException'))
          setError(caught instanceof Error ? caught.message : '페이지 표시 오류');
      })
      .finally(() => {
        if (activeRender.current === task) activeRender.current = null;
      });
    return () => {
      active = false;
      task?.cancel();
    };
  }, [pdf, current, availableWidth, zoom]);
  useEffect(() => {
    if (!currentPage || !ready) return;
    const target = scrollTarget?.page === current ? scrollTarget : null;
    const previous = lastScroll.current;
    if (previous?.pdf === pdf && previous.page === current && previous.target === target) return;
    const viewport = scroll.current;
    const paper = canvas.current?.parentElement;
    if (!viewport || !paper) return;
    if (target) {
      const viewportRect = viewport.getBoundingClientRect();
      const paperRect = paper.getBoundingClientRect();
      const style = getComputedStyle(viewport);
      viewport.scrollTo({
        top: Math.max(
          0,
          paperRect.top -
            viewportRect.top +
            viewport.scrollTop +
            target.rect.y * currentPage.scale -
            parseFloat(style.paddingTop),
        ),
        left: Math.max(
          0,
          paperRect.left -
            viewportRect.left +
            viewport.scrollLeft +
            target.rect.x * currentPage.scale -
            parseFloat(style.paddingLeft),
        ),
        behavior: 'auto',
      });
    } else viewport.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    lastScroll.current = { pdf: currentPage.pdf, page: current, target };
  }, [currentPage, ready, scrollTarget, current, pdf]);
  const dimensions = rendered ?? { width: 1, height: 1, scale: 1 };
  return (
    <section
      ref={frame}
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
      <div className="pdf-canvas-scroll" ref={scroll}>
        <div
          className="pdf-paper"
          style={{
            width: dimensions.width,
            height: dimensions.height,
            visibility: currentPage && !error ? 'visible' : 'hidden',
          }}
        >
          <canvas
            ref={canvas}
            aria-label={`${label} ${current}쪽`}
            style={{ width: dimensions.width, height: dimensions.height }}
          />
          {currentPage && highlight && (
            <div
              className="pdf-highlight"
              style={{
                left: highlight.x * dimensions.scale,
                top: highlight.y * dimensions.scale,
                width: highlight.width * dimensions.scale,
                height: highlight.height * dimensions.scale,
              }}
            />
          )}
        </div>
      </div>
      {data && !ready && !error && (
        <div className="pdf-loading" role="status" aria-label="불러오는 중">
          <span />
        </div>
      )}
      {error && (
        <p className="pdf-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
