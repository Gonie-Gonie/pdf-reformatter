import { useCallback, useEffect, useRef, useState } from 'react';
import {
  analyzePdf,
  cancelJob,
  clearDocument,
  convertPdf,
  getSourceBytes,
} from '../adapters/pdf/client';
import { downloadFile } from '../adapters/platform/download';
import { DEFAULT_CONFIG, validateConfig } from '../core/config';
import { buildPageLinks } from '../core/navigation';
import type { PageAnchor, PageLink, PageLinks } from '../core/navigation';
import type {
  ConversionResult,
  CriticalIssue,
  LayoutConfig,
  Overrides,
  Progress,
  ReadingDocument,
  SourceDocument,
} from '../core/model';
import { Icon } from '../components/Icon';
import { PdfViewer } from '../components/PdfViewer';

type NumericConfig = Exclude<keyof LayoutConfig, 'fontFamily' | 'theme'>;
type Tab = 'preview' | 'review';
interface DocumentSession {
  source: SourceDocument;
  reading: ReadingDocument;
  bytes: Uint8Array;
}

const presets = [
  { name: 'Fold7', shape: 'fold', width: 492, height: 546 },
  { name: '스마트폰', shape: 'phone', width: 360, height: 640 },
  { name: 'A5', shape: 'a5', width: 419.53, height: 595.28 },
] as const;

function safeName(name: string): string {
  return name.replace(/\.pdf$/i, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') || 'document';
}

function previewPages(count: number): number[] {
  return Array.from({ length: Math.min(10, count) }, (_, index) => index + 1);
}

function App() {
  const [config, setConfig] = useState<LayoutConfig>({ ...DEFAULT_CONFIG });
  const [unit, setUnit] = useState<'mm' | 'pt'>('mm');
  const [session, setSession] = useState<DocumentSession | null>(null);
  const [result, setResult] = useState<ConversionResult | null>(null);
  const [pageLinks, setPageLinks] = useState<PageLinks | null>(null);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('preview');
  const [sourcePage, setSourcePage] = useState(1);
  const [outputPage, setOutputPage] = useState(1);
  const [sourceTarget, setSourceTarget] = useState<PageAnchor | null>(null);
  const [outputTarget, setOutputTarget] = useState<PageAnchor | null>(null);
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [passwordRequired, setPasswordRequired] = useState(false);
  const [password, setPassword] = useState('');
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const sessionRef = useRef<DocumentSession | null>(null);
  const configRef = useRef(config);
  const overridesRef = useRef<Overrides>({});
  const busyRef = useRef(false);
  const previewTimer = useRef<number | undefined>(undefined);

  const performConversion = useCallback(
    async (document: DocumentSession, full: boolean, job: number) => {
      const converted = await convertPdf(
        document.source,
        document.reading,
        validateConfig(configRef.current),
        overridesRef.current,
        (value) => {
          if (generation.current === job) setProgress(value);
        },
        full ? undefined : previewPages(document.source.pageCount),
      );
      if (generation.current !== job) return;
      const links = buildPageLinks(converted.source, converted.reading, converted.layout);
      const first = links.byOutput.get(1);
      const nextSession = {
        ...document,
        source: converted.source,
        reading: converted.reading,
      };
      sessionRef.current = nextSession;
      setSession(nextSession);
      setResult(converted);
      setPageLinks(links);
      setStale(false);
      setSourcePage(first?.source.page ?? 1);
      setOutputPage(1);
      setSourceTarget(first ? { ...first.source } : null);
      setOutputTarget(first ? { ...first.output } : null);
      setSelectedIssueId((previous) =>
        converted.issues.some((issue) => issue.id === previous) ? previous : null,
      );
    },
    [],
  );

  const runConversion = useCallback(
    async (full: boolean) => {
      const document = sessionRef.current;
      if (!document || busyRef.current) return;
      if (full) window.clearTimeout(previewTimer.current);
      const job = ++generation.current;
      busyRef.current = true;
      setBusy(true);
      setError('');
      setProgress({ stage: 'converting', current: 0, total: 1, message: '변환 중' });
      try {
        await performConversion(document, full, job);
      } catch (caught) {
        if (generation.current === job)
          setError(caught instanceof Error ? caught.message : '변환 오류');
      } finally {
        if (generation.current === job) {
          busyRef.current = false;
          setBusy(false);
          setProgress(null);
        }
      }
    },
    [performConversion],
  );

  useEffect(() => {
    if (!previewRevision || !sessionRef.current) return;
    const timer = window.setTimeout(() => void runConversion(false), 350);
    previewTimer.current = timer;
    return () => window.clearTimeout(timer);
  }, [previewRevision, runConversion]);

  useEffect(
    () => () => {
      generation.current += 1;
      cancelJob();
    },
    [],
  );

  useEffect(() => {
    if (!passwordRequired) return;
    const previous = document.activeElement as HTMLElement | null;
    const timer = window.setTimeout(() => {
      document.querySelector<HTMLInputElement>('.dialog-card input')?.focus();
    }, 0);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPasswordRequired(false);
        setPassword('');
        setPendingFile(null);
      }
      if (event.key !== 'Tab') return;
      const controls = Array.from(
        document.querySelectorAll<HTMLElement>(
          '.dialog-card button:not(:disabled), .dialog-card input:not(:disabled)',
        ),
      );
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, [passwordRequired]);

  async function openFile(file: File, suppliedPassword?: string) {
    if (sessionRef.current || busyRef.current) return;
    const job = ++generation.current;
    window.clearTimeout(previewTimer.current);
    clearDocument();
    sessionRef.current = null;
    overridesRef.current = {};
    busyRef.current = true;
    setSession(null);
    setResult(null);
    setPageLinks(null);
    setStale(false);
    setBusy(true);
    setError('');
    setProgress({ stage: 'loading', current: 0, total: 1, message: 'PDF 여는 중' });
    setPendingFile(file);
    setPasswordRequired(false);
    setSelectedIssueId(null);
    setSourcePage(1);
    setOutputPage(1);
    setSourceTarget(null);
    setOutputTarget(null);
    setTab('preview');
    try {
      const analyzed = await analyzePdf(
        file,
        (value) => {
          if (generation.current === job) setProgress(value);
        },
        suppliedPassword,
        10,
      );
      if (generation.current !== job) return;
      const bytes = getSourceBytes();
      if (!bytes) throw new Error('원본 PDF를 열 수 없습니다.');
      const document = { ...analyzed, bytes: bytes.slice() };
      sessionRef.current = document;
      setSession(document);
      setPendingFile(null);
      setPassword('');
      await performConversion(document, false, job);
    } catch (caught) {
      if (generation.current !== job) return;
      const message = caught instanceof Error ? caught.message : 'PDF 열기 오류';
      if (/password|암호|비밀번호/i.test(message)) {
        setPasswordRequired(true);
        setError(suppliedPassword ? '암호가 맞지 않습니다.' : '');
      } else {
        setError(message);
        setPendingFile(null);
      }
    } finally {
      if (generation.current === job) {
        busyRef.current = false;
        setBusy(false);
        setProgress(null);
      }
    }
  }

  function cancel() {
    generation.current += 1;
    window.clearTimeout(previewTimer.current);
    cancelJob();
    busyRef.current = false;
    setBusy(false);
    setProgress(null);
    setPendingFile(null);
  }

  function closeDocument() {
    generation.current += 1;
    window.clearTimeout(previewTimer.current);
    clearDocument();
    sessionRef.current = null;
    overridesRef.current = {};
    busyRef.current = false;
    setSession(null);
    setResult(null);
    setPageLinks(null);
    setSourceTarget(null);
    setOutputTarget(null);
    setStale(false);
    setBusy(false);
    setProgress(null);
    setSelectedIssueId(null);
    setError('');
    setPendingFile(null);
    setPasswordRequired(false);
    setPassword('');
  }

  function markChanged() {
    setStale(true);
    setPreviewRevision((previous) => previous + 1);
  }

  function changeConfig(next: LayoutConfig) {
    configRef.current = next;
    setConfig(next);
    markChanged();
  }

  function changeNumber(key: NumericConfig, value: string, dimensions: boolean) {
    const number = value === '' ? Number.NaN : Number(value);
    changeConfig({
      ...config,
      [key]: dimensions && unit === 'mm' ? (number * 72) / 25.4 : number,
    });
  }

  function preserveIssue(issue: CriticalIssue) {
    if (!issue.blockId || busyRef.current) return;
    overridesRef.current = {
      ...overridesRef.current,
      [issue.blockId]: { ...overridesRef.current[issue.blockId], kind: 'sourceRegion' },
    };
    markChanged();
  }

  function navigateLink(link: PageLink) {
    setSourcePage(link.source.page);
    setOutputPage(link.output.page);
    setSourceTarget({ ...link.source });
    setOutputTarget({ ...link.output });
  }

  function changeSourcePage(page: number) {
    const next = Math.min(session?.source.pageCount ?? 1, Math.max(1, Math.trunc(page) || 1));
    const link = pageLinks?.bySource.get(next);
    if (link) navigateLink(link);
    else {
      setSourcePage(next);
      setSourceTarget(null);
    }
  }

  function changeOutputPage(page: number) {
    const next = Math.min(result?.layout.pages.length ?? 1, Math.max(1, Math.trunc(page) || 1));
    const link = pageLinks?.byOutput.get(next);
    if (link) navigateLink(link);
    else {
      setOutputPage(next);
      setOutputTarget(null);
    }
  }

  function selectIssue(issue: CriticalIssue) {
    setSelectedIssueId(issue.id);
    changeSourcePage(issue.sourcePage);
    if (issue.rect) setSourceTarget({ page: issue.sourcePage, rect: issue.rect });
    if (!issue.blockId) return;
    const page = result?.layout.pages.find((item) =>
      item.placements.some((placement) => placement.blockId === issue.blockId),
    );
    const placement = page?.placements.find((item) => item.blockId === issue.blockId);
    if (page && placement) {
      setOutputPage(page.number);
      setOutputTarget({ page: page.number, rect: placement });
    }
  }

  function downloadResult() {
    if (!result || result.scope !== 'full' || stale || busy || !session) return;
    downloadFile(
      result.readingPdf,
      `${safeName(session.source.name)}-formatted.pdf`,
      'application/pdf',
    );
  }

  function jumpTo(id: string) {
    const element = document.getElementById(id);
    element?.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      block: 'start',
    });
    element?.focus({ preventScroll: true });
  }

  function displayDimension(value: number) {
    return unit === 'mm'
      ? Math.round(((value * 25.4) / 72) * 10) / 10
      : Math.round(value * 100) / 100;
  }

  function numberField(key: NumericConfig, label: string, dimensions = false, step = 1) {
    const displayed = dimensions
      ? displayDimension(config[key])
      : Math.round(config[key] * 100) / 100;
    return (
      <label className="number-field" key={key}>
        <span>{label}</span>
        <div>
          <input
            type="number"
            value={Number.isFinite(displayed) ? displayed : ''}
            min="0"
            step={step}
            aria-label={label}
            disabled={busy}
            onChange={(event) => changeNumber(key, event.target.value, dimensions)}
          />
          <span>{dimensions ? unit : 'pt'}</span>
        </div>
      </label>
    );
  }

  const source = session?.source;
  const issues = result?.issues ?? [];
  const selectedIssue = issues.find((issue) => issue.id === selectedIssueId);
  const fraction = progress?.total
    ? Math.min(100, Math.max(0, (progress.current / progress.total) * 100))
    : 0;

  return (
    <div className="app-shell">
      <header className="app-header" inert={passwordRequired}>
        <div className="brand">
          <span className="brand-symbol">
            <Icon name="book" size={21} />
          </span>
          <span>
            PDF <strong>Reflow</strong>
          </span>
        </div>
        <button
          className="icon-button mobile-settings-button"
          aria-label="설정으로 이동"
          onClick={() => jumpTo('reading-settings')}
        >
          <Icon name="settings" size={19} />
        </button>
      </header>

      <div className="workspace" inert={passwordRequired}>
        <aside id="reading-settings" tabIndex={-1} className="settings-sidebar" aria-label="설정">
          <section className="settings-section">
            <div className="section-label">
              <h2>페이지 크기</h2>
              <div className="unit-toggle" role="group" aria-label="크기 단위">
                <button
                  aria-pressed={unit === 'mm'}
                  className={unit === 'mm' ? 'active' : ''}
                  onClick={() => setUnit('mm')}
                >
                  mm
                </button>
                <button
                  aria-pressed={unit === 'pt'}
                  className={unit === 'pt' ? 'active' : ''}
                  onClick={() => setUnit('pt')}
                >
                  pt
                </button>
              </div>
            </div>
            <div className="field-pair">
              {numberField('pageWidthPt', '가로', true, 0.1)}
              {numberField('pageHeightPt', '세로', true, 0.1)}
            </div>
            <p className="preset-label">preset</p>
            <div className="preset-grid">
              {presets.map((preset) => {
                const active =
                  Math.abs(config.pageWidthPt - preset.width) < 0.05 &&
                  Math.abs(config.pageHeightPt - preset.height) < 0.05;
                return (
                  <button
                    key={preset.name}
                    className={`preset-card ${active ? 'active' : ''}`}
                    disabled={busy}
                    aria-pressed={active}
                    onClick={() =>
                      changeConfig({
                        ...config,
                        pageWidthPt: preset.width,
                        pageHeightPt: preset.height,
                      })
                    }
                  >
                    <span className={`preset-shape ${preset.shape}`} />
                    <strong>{preset.name}</strong>
                    <small>
                      {displayDimension(preset.width)} × {displayDimension(preset.height)}
                    </small>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="settings-section">
            <div className="section-label">
              <h2>종이</h2>
            </div>
            <div className="theme-options" role="group" aria-label="종이">
              <button
                disabled={busy}
                aria-pressed={config.theme === 'warm'}
                className={`theme-option warm ${config.theme === 'warm' ? 'active' : ''}`}
                onClick={() => changeConfig({ ...config, theme: 'warm' })}
              >
                <span>Aa</span>따뜻한 종이
                {config.theme === 'warm' && <Icon name="check" size={13} />}
              </button>
              <button
                disabled={busy}
                aria-pressed={config.theme === 'light'}
                className={`theme-option light ${config.theme === 'light' ? 'active' : ''}`}
                onClick={() => changeConfig({ ...config, theme: 'light' })}
              >
                <span>Aa</span>흰 종이
                {config.theme === 'light' && <Icon name="check" size={13} />}
              </button>
            </div>
          </section>

          <section className="settings-section">
            <div className="section-label">
              <h2>글과 문단</h2>
            </div>
            <div className="font-options" role="group" aria-label="글꼴">
              <button
                disabled={busy}
                aria-pressed={config.fontFamily === 'serif'}
                className={`font-option serif ${config.fontFamily === 'serif' ? 'active' : ''}`}
                onClick={() => changeConfig({ ...config, fontFamily: 'serif' })}
              >
                명조
              </button>
              <button
                disabled={busy}
                aria-pressed={config.fontFamily === 'sans'}
                className={`font-option sans ${config.fontFamily === 'sans' ? 'active' : ''}`}
                onClick={() => changeConfig({ ...config, fontFamily: 'sans' })}
              >
                고딕
              </button>
            </div>
            <div className="field-pair">
              {numberField('fontSizePt', '글자 크기', false, 0.1)}
              {numberField('lineHeightPt', '행간', false, 0.1)}
            </div>
            <div className="margin-settings">
              <p className="margin-settings-label">여백과 문단</p>
              <div className="field-pair">
                {numberField('marginTopPt', '위 여백', true, 0.1)}
                {numberField('marginBottomPt', '아래 여백', true, 0.1)}
                {numberField('marginLeftPt', '왼쪽 여백', true, 0.1)}
                {numberField('marginRightPt', '오른쪽 여백', true, 0.1)}
                {numberField('paragraphGapPt', '문단 간격', false, 0.1)}
              </div>
            </div>
          </section>
          <button
            className="text-button reset-button"
            disabled={busy}
            onClick={() => changeConfig({ ...DEFAULT_CONFIG })}
          >
            <Icon name="refresh" size={14} />
            기본 설정으로
          </button>
          <button
            className="small-button mobile-return-button"
            onClick={() => jumpTo('document-workspace')}
          >
            <Icon name="up" size={15} />
            {source ? '문서로 이동' : 'PDF 선택으로 이동'}
          </button>
        </aside>

        <main id="document-workspace" tabIndex={-1} className="main-workspace">
          <input
            ref={fileInput}
            id="pdf-file-input"
            type="file"
            accept=".pdf,application/pdf"
            className="visually-hidden"
            disabled={busy || Boolean(session)}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void openFile(file);
              event.target.value = '';
            }}
          />

          {(source || busy) && (
            <div
              className="document-toolbar"
              data-scope={result?.scope ?? 'none'}
              data-stale={stale ? 'true' : 'false'}
              data-selected-pages={result?.selectedPages.join(',')}
            >
              {source && (
                <div className="document-toolbar-main">
                  <div className="document-name">
                    <Icon name="file" size={22} />
                    <div>
                      <h1 title={source.name}>{source.name}</h1>
                      <span>{source.pageCount}쪽</span>
                    </div>
                  </div>
                  <div className="document-actions">
                    <button
                      className="icon-button"
                      disabled={busy}
                      aria-label="문서 닫기"
                      title="문서 닫기"
                      onClick={closeDocument}
                    >
                      <Icon name="close" size={18} />
                    </button>
                    <span className="action-divider" />
                    <button
                      className="primary-button"
                      disabled={busy}
                      onClick={() => void runConversion(true)}
                    >
                      <Icon name="refresh" size={15} />
                      변환
                    </button>
                    <button
                      className="small-button download-button"
                      disabled={busy || stale || result?.scope !== 'full'}
                      onClick={downloadResult}
                    >
                      <Icon name="download" size={16} />
                      다운로드
                    </button>
                  </div>
                </div>
              )}
              {busy && (
                <div className="progress-row" role="status" aria-live="polite">
                  <span className="spinner" />
                  <span className="progress-label">{progress?.message ?? '변환 중'}</span>
                  {progress && (
                    <span className="progress-numbers">
                      {progress.current} / {progress.total}
                    </span>
                  )}
                  <button className="text-button" onClick={cancel}>
                    취소
                  </button>
                  <progress value={fraction} max="100" aria-label="처리 진행률" />
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="message error-message" role="alert">
              <Icon name="alert" size={18} />
              <span>{error}</span>
              <button className="icon-button" aria-label="오류 닫기" onClick={() => setError('')}>
                <Icon name="close" size={15} />
              </button>
            </div>
          )}

          {!session ? (
            <div className="welcome-screen">
              <div
                className={`upload-area ${dragging ? 'dragging' : ''}`}
                aria-label="PDF 업로드"
                onDragOver={(event) => {
                  event.preventDefault();
                  if (!busy) setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragging(false);
                  const file = event.dataTransfer.files[0];
                  if (file && !busy) void openFile(file);
                }}
              >
                <div className="upload-icon">
                  <Icon name="upload" size={28} />
                </div>
                <button
                  className="primary-button"
                  disabled={busy}
                  onClick={() => fileInput.current?.click()}
                >
                  <Icon name="folder" size={17} />
                  PDF 선택
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="document-tabs-row">
                <div className="tabs" role="tablist" aria-label="문서 작업">
                  <button
                    id="preview-tab"
                    role="tab"
                    aria-controls="document-panel"
                    aria-selected={tab === 'preview'}
                    className={tab === 'preview' ? 'active' : ''}
                    onClick={() => setTab('preview')}
                  >
                    미리보기
                  </button>
                  <button
                    id="review-tab"
                    role="tab"
                    aria-controls="document-panel"
                    aria-selected={tab === 'review'}
                    className={tab === 'review' ? 'active' : ''}
                    onClick={() => setTab('review')}
                  >
                    검토 필요
                    {issues.length > 0 && <span className="issue-count">{issues.length}</span>}
                  </button>
                </div>
                <span className="result-scope">
                  {stale
                    ? '설정 변경'
                    : result?.scope === 'preview'
                      ? `미리보기 · 1–${Math.min(10, session.source.pageCount)}쪽`
                      : result?.scope === 'full'
                        ? '전체'
                        : ''}
                </span>
              </div>

              <div
                id="document-panel"
                role="tabpanel"
                aria-labelledby={tab === 'preview' ? 'preview-tab' : 'review-tab'}
              >
                {tab === 'review' && (
                  <div className="critical-review">
                    {issues.length === 0 ? (
                      <p className="review-empty">없음</p>
                    ) : (
                      <>
                        <div className="critical-issues" aria-label="검토 필요 항목">
                          {issues.map((issue) => (
                            <button
                              key={issue.id}
                              className={`critical-issue ${selectedIssueId === issue.id ? 'active' : ''}`}
                              aria-pressed={selectedIssueId === issue.id}
                              onClick={() => selectIssue(issue)}
                            >
                              <span className="issue-page">{issue.sourcePage}쪽</span>
                              <span>{issue.message}</span>
                            </button>
                          ))}
                        </div>
                        {selectedIssue?.blockId && (
                          <button
                            className="small-button preserve-button"
                            disabled={busy}
                            onClick={() => preserveIssue(selectedIssue)}
                          >
                            원문 보존
                          </button>
                        )}
                      </>
                    )}
                  </div>
                )}
                <div className="preview-grid">
                  <PdfViewer
                    data={session.bytes}
                    page={sourcePage}
                    onPageChange={changeSourcePage}
                    scrollTarget={sourceTarget}
                    label="원문"
                    highlight={
                      tab === 'review' && selectedIssue?.sourcePage === sourcePage
                        ? selectedIssue.rect
                        : null
                    }
                  />
                  <PdfViewer
                    data={result?.readingPdf ?? null}
                    page={outputPage}
                    onPageChange={changeOutputPage}
                    scrollTarget={outputTarget}
                    label="변환 결과"
                  />
                </div>
              </div>
            </>
          )}
        </main>
      </div>

      {passwordRequired && (
        <div className="dialog-backdrop">
          <form
            className="dialog-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="password-title"
            onSubmit={(event) => {
              event.preventDefault();
              if (pendingFile) void openFile(pendingFile, password);
            }}
          >
            <h2 id="password-title">PDF 암호</h2>
            <label className="password-field">
              <span className="visually-hidden">암호</span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="off"
                required
              />
            </label>
            {error && (
              <p className="dialog-error" role="alert">
                {error}
              </p>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                className="small-button"
                onClick={() => {
                  setPasswordRequired(false);
                  setPassword('');
                  setPendingFile(null);
                }}
              >
                취소
              </button>
              <button className="primary-button" type="submit">
                열기
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

export default App;
