import { useEffect, useMemo, useRef, useState } from 'react';
import {
  analyzePdf,
  cancelJob,
  clearDocument,
  convertPdf,
  getSourceBytes,
} from '../adapters/pdf/client';
import {
  deleteProject,
  downloadFile,
  loadProject,
  parseProject,
  saveProject,
} from '../adapters/storage/project';
import { DEFAULT_CONFIG, validateConfig } from '../core/config';
import type {
  BlockKind,
  ConversionResult,
  LayoutConfig,
  Overrides,
  Progress,
  ReadingBlock,
  ReadingDocument,
  SavedProject,
  SourceDocument,
} from '../core/model';
import { Icon } from '../components/Icon';
import { PdfViewer } from '../components/PdfViewer';

const kindLabels: Record<BlockKind, string> = {
  heading: '제목',
  paragraph: '본문',
  list: '목록',
  caption: '캡션',
  footnote: '각주',
  reference: '참고문헌',
  sourceRegion: '원형 보존',
};
const kindOptions = Object.entries(kindLabels) as [BlockKind, string][];
type Tab = 'preview' | 'review' | 'report';
type NumericConfig = Exclude<keyof LayoutConfig, 'fontFamily' | 'theme'>;

function parseRange(value: string, count: number): number[] {
  const result = new Set<number>();
  if (!value.trim()) throw new Error('미리 볼 원문 쪽수를 입력해 주세요. 예: 1-3, 5');
  for (const piece of value.split(',')) {
    const match = piece.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!match) throw new Error('쪽수는 1-3, 5와 같은 형식으로 입력해 주세요.');
    const start = Number(match[1]);
    const end = Number(match[2] || match[1]);
    if (start < 1 || end < start || end > count)
      throw new Error(`쪽수는 1부터 ${count} 사이여야 합니다.`);
    for (let n = start; n <= end; n += 1) result.add(n);
  }
  return [...result].sort((a, b) => a - b);
}

function safeName(name: string): string {
  return name.replace(/\.pdf$/i, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') || 'document';
}
function humanBytes(size: number) {
  return size < 1048576
    ? `${Math.max(1, Math.round(size / 1024))} KB`
    : `${(size / 1048576).toFixed(1)} MB`;
}
function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

function App() {
  const [config, setConfig] = useState<LayoutConfig>({ ...DEFAULT_CONFIG });
  const [unit, setUnit] = useState<'pt' | 'mm'>('mm');
  const [source, setSource] = useState<SourceDocument | null>(null);
  const [sourceBytes, setSourceBytes] = useState<Uint8Array | null>(null);
  const [reading, setReading] = useState<ReadingDocument | null>(null);
  const [overrides, setOverrides] = useState<Overrides>({});
  const [result, setResult] = useState<ConversionResult | null>(null);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [tab, setTab] = useState<Tab>('preview');
  const [sourcePage, setSourcePage] = useState(1);
  const [outputPage, setOutputPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reviewPage, setReviewPage] = useState('all');
  const [reviewOnly, setReviewOnly] = useState(false);
  const [reviewLimit, setReviewLimit] = useState(60);
  const [range, setRange] = useState('1-3');
  const [pendingProject, setPendingProject] = useState<SavedProject | null>(null);
  const [pendingIsStored, setPendingIsStored] = useState(false);
  const [storedProjectExists, setStoredProjectExists] = useState(false);
  const [restoreRequested, setRestoreRequested] = useState(false);
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [passwordRequired, setPasswordRequired] = useState(false);
  const [password, setPassword] = useState('');
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const projectInput = useRef<HTMLInputElement>(null);
  const generation = useRef(0);

  useEffect(() => {
    let active = true;
    void loadProject()
      .then((project) => {
        if (active && project) {
          setPendingProject(project);
          setPendingIsStored(true);
          setStoredProjectExists(true);
        }
      })
      .catch(() => {
        /* Storage is optional. */
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    return () => {
      cancelJob();
    };
  }, []);
  useEffect(() => {
    if (!passwordRequired) return;
    const previous = document.activeElement as HTMLElement | null;
    const timer = window.setTimeout(() => {
      (
        document.querySelector<HTMLElement>('.dialog-card input') ??
        document.querySelector<HTMLElement>('.dialog-card button')
      )?.focus();
    }, 0);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPasswordRequired(false);
        setPassword('');
      }
      if (event.key !== 'Tab') return;
      const controls = Array.from(
        document.querySelectorAll<HTMLElement>(
          '.dialog-card button:not(:disabled), .dialog-card input:not(:disabled), .dialog-card a[href]',
        ),
      );
      if (!controls.length) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, [passwordRequired]);

  const effectiveBlocks = useMemo(() => {
    if (!reading) return [];
    return reading.blocks
      .map((block, index) => ({ ...block, ...overrides[block.id], originalIndex: index }))
      .sort((a, b) => (a.order ?? a.originalIndex) - (b.order ?? b.originalIndex));
  }, [reading, overrides]);
  const selected = reading?.blocks.find((block) => block.id === selectedId) ?? null;
  const selectedOverride = selected ? overrides[selected.id] : undefined;
  const highlight = selected && selected.sourcePage === sourcePage ? selected.rect : null;
  const reviewedCount = effectiveBlocks.filter(
    (block) => block.confidence === 'review' && !block.excluded,
  ).length;
  const visibleBlocks = effectiveBlocks.filter(
    (block) =>
      (reviewPage === 'all' || block.sourcePage === Number(reviewPage)) &&
      (!reviewOnly || block.confidence === 'review'),
  );
  const excludedCount = effectiveBlocks.filter((block) => block.excluded).length;
  const preserveCount = effectiveBlocks.filter(
    (block) => block.kind === 'sourceRegion' && !block.excluded,
  ).length;
  const fraction =
    progress && progress.total > 0
      ? Math.min(100, Math.max(0, (progress.current / progress.total) * 100))
      : 0;

  function markChanged() {
    if (result) setStale(true);
    setLastSaved(null);
  }
  function jumpTo(id: string) {
    const element = document.getElementById(id);
    element?.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      block: 'start',
    });
    element?.focus({ preventScroll: true });
  }
  function changeConfig(next: LayoutConfig) {
    setConfig(next);
    markChanged();
  }
  function changeNumber(key: NumericConfig, value: string, dimensions = false) {
    const number = Number(value);
    changeConfig({ ...config, [key]: dimensions && unit === 'mm' ? (number * 72) / 25.4 : number });
  }
  function changeOverride(id: string, patch: Overrides[string]) {
    setOverrides((previous) => ({ ...previous, [id]: { ...previous[id], ...patch } }));
    markChanged();
  }
  function selectBlock(block: ReadingBlock) {
    setSelectedId(block.id);
    setSourcePage(block.sourcePage);
  }
  function moveBlock(id: string, direction: -1 | 1) {
    const list = effectiveBlocks.slice();
    const index = list.findIndex((block) => block.id === id);
    if (index < 0 || index + direction < 0 || index + direction >= list.length) return;
    [list[index], list[index + direction]] = [list[index + direction], list[index]];
    setOverrides((previous) =>
      Object.fromEntries(list.map((block, order) => [block.id, { ...previous[block.id], order }])),
    );
    markChanged();
  }
  function makeProject(): SavedProject {
    if (!source || !reading) throw new Error('먼저 PDF를 열어 주세요.');
    return {
      schemaVersion: 1,
      sourceHash: source.hash,
      sourceName: source.name,
      config: validateConfig(config),
      overrides,
      reading,
      savedAt: new Date().toISOString(),
    };
  }
  function applyProject(project: SavedProject, doc: SourceDocument, fromStorage = false) {
    if (project.sourceHash !== doc.hash)
      throw new Error(
        '저장된 작업과 PDF의 SHA-256이 다릅니다. 작업을 저장할 때 사용한 원본 PDF를 열어 주세요.',
      );
    setConfig(validateConfig(project.config));
    setReading(project.reading);
    setOverrides(project.overrides);
    setSelectedId(null);
    setResult(null);
    setStale(false);
    setPendingProject(null);
    setRestoreRequested(false);
    setNotice('원본 해시를 확인하고 설정과 수동 보정을 복원했습니다.');
    setLastSaved(fromStorage ? project.savedAt : null);
    setPendingIsStored(false);
  }
  async function openFile(file: File, suppliedPassword?: string) {
    if (busy) return;
    if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
      setError('PDF 파일을 선택해 주세요.');
      return;
    }
    const job = ++generation.current;
    setBusy(true);
    setError('');
    setNotice('');
    setProgress({ stage: 'loading', current: 0, total: 1, message: 'PDF를 여는 중입니다.' });
    setPendingFile(file);
    try {
      const analyzed = await analyzePdf(
        file,
        (p) => {
          if (generation.current === job) setProgress(p);
        },
        suppliedPassword,
      );
      if (generation.current !== job) return;
      setSource(analyzed.source);
      setReading(analyzed.reading);
      setSourceBytes(getSourceBytes()?.slice() ?? null);
      setOverrides({});
      setResult(null);
      setStale(false);
      setSelectedId(null);
      setSourcePage(1);
      setOutputPage(1);
      setTab('preview');
      setReviewPage('all');
      setReviewLimit(60);
      setRange(analyzed.source.pageCount < 3 ? `1-${analyzed.source.pageCount}` : '1-3');
      setPasswordRequired(false);
      setPassword('');
      setPendingFile(null);
      setLastSaved(null);
      if (pendingProject && restoreRequested) {
        if (pendingProject.sourceHash === analyzed.source.hash)
          applyProject(pendingProject, analyzed.source, pendingIsStored);
        else
          setError(
            '선택한 PDF가 저장된 작업의 원본과 다릅니다. 새 문서로 열었습니다. 저장된 보정은 적용하지 않았습니다.',
          );
      }
    } catch (caught) {
      if (generation.current !== job) return;
      const message = caught instanceof Error ? caught.message : 'PDF를 열지 못했습니다.';
      setError(message);
      if (/password|암호|비밀번호/i.test(message)) setPasswordRequired(true);
    } finally {
      if (generation.current === job) {
        setBusy(false);
        setProgress(null);
      }
    }
  }
  async function runConvert(preview = false) {
    if (!source || !reading || busy) return;
    const job = ++generation.current;
    try {
      const checked = validateConfig(config);
      const selectedPages = preview ? parseRange(range, source.pageCount) : undefined;
      setError('');
      setNotice('');
      setBusy(true);
      setProgress({
        stage: 'laying-out',
        current: 0,
        total: 1,
        message: '읽기본을 조판하는 중입니다.',
      });
      const converted = await convertPdf(
        source,
        reading,
        checked,
        overrides,
        (p) => {
          if (generation.current === job) setProgress(p);
        },
        selectedPages,
      );
      if (generation.current !== job) return;
      setResult(converted);
      setStale(false);
      setOutputPage(1);
      setTab('preview');
      setSelectedId(null);
      setNotice(
        preview
          ? '선택한 범위의 미리보기 PDF를 만들었습니다. 전체 문서는 ‘전체 변환’으로 만들 수 있습니다.'
          : '전체 문서의 읽기본과 원문 대조 합본을 만들었습니다. 검증 보고서도 확인해 주세요.',
      );
    } catch (caught) {
      if (generation.current === job)
        setError(caught instanceof Error ? caught.message : '변환 중 오류가 발생했습니다.');
    } finally {
      if (generation.current === job) {
        setBusy(false);
        setProgress(null);
      }
    }
  }
  function cancel() {
    generation.current += 1;
    cancelJob();
    setBusy(false);
    setProgress(null);
    setNotice('작업을 취소했습니다. 설정과 보정은 유지됩니다.');
  }
  function closeDocument() {
    generation.current += 1;
    clearDocument();
    setSource(null);
    setSourceBytes(null);
    setReading(null);
    setOverrides({});
    setResult(null);
    setSelectedId(null);
    setStale(false);
    setError('');
    setNotice('');
    setBusy(false);
    setProgress(null);
    setPasswordRequired(false);
    setPendingFile(null);
  }
  async function saveLocal() {
    try {
      const project = makeProject();
      await saveProject(project);
      setLastSaved(project.savedAt);
      setStoredProjectExists(true);
      setPendingIsStored(false);
      setPendingProject(null);
      setNotice('이 브라우저에 작업을 저장했습니다. 원본 PDF 바이트는 저장하지 않습니다.');
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : '작업을 저장하지 못했습니다. 작업 파일로 내보내기를 사용해 주세요.',
      );
    }
  }
  function exportProject() {
    try {
      const project = makeProject();
      downloadFile(
        JSON.stringify(project, null, 2),
        `${safeName(project.sourceName)}.reflow-project`,
        'application/json',
      );
      setNotice(
        '설정·보정·추출 텍스트가 담긴 작업 파일을 저장했습니다. 원본 PDF는 별도로 보관해 주세요.',
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '작업을 내보내지 못했습니다.');
    }
  }
  async function importProject(file: File) {
    try {
      if (file.size > 50 * 1024 * 1024) throw new Error('작업 파일은 50 MB 이하여야 합니다.');
      const project = parseProject(await file.text());
      if (source && source.hash === project.sourceHash) applyProject(project, source);
      else {
        setPendingProject(project);
        setPendingIsStored(false);
        setRestoreRequested(true);
        setNotice(`‘${project.sourceName}’ 원본 PDF를 열면 작업을 복원합니다.`);
      }
      setError('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '작업 파일을 가져오지 못했습니다.');
    }
  }
  function restoreLocal() {
    if (!pendingProject) return;
    if (source?.hash === pendingProject.sourceHash) {
      try {
        applyProject(pendingProject, source, pendingIsStored);
      } catch (caught) {
        setError(String(caught));
      }
    } else {
      setRestoreRequested(true);
      fileInput.current?.click();
    }
  }
  async function eraseSaved() {
    try {
      await deleteProject();
      if (pendingIsStored) setPendingProject(null);
      setPendingIsStored(false);
      setStoredProjectExists(false);
      setLastSaved(null);
      setNotice('이 브라우저에 저장된 작업을 삭제했습니다. 다운로드한 파일은 유지됩니다.');
    } catch {
      setError('브라우저 저장소의 작업을 삭제하지 못했습니다.');
    }
  }
  function downloadResult(kind: 'reading' | 'comparison' | 'json' | 'html') {
    if (!result || stale || !source) return;
    const stem = `${safeName(source.name)}${result.report.scope === 'preview' ? '-preview' : ''}`;
    if (kind === 'reading')
      downloadFile(result.readingPdf, `${stem}-reading.pdf`, 'application/pdf');
    else if (kind === 'comparison')
      downloadFile(result.comparisonPdf, `${stem}-comparison.pdf`, 'application/pdf');
    else if (kind === 'json')
      downloadFile(
        JSON.stringify(result.report, null, 2),
        `${stem}-report.json`,
        'application/json',
      );
    else {
      const report = result.report;
      const html = `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>PDF Reflow 검증 보고서</title><style>body{font:15px/1.7 system-ui;max-width:1000px;padding:36px;margin:auto;color:#302b27}table{border-collapse:collapse;width:100%}td,th{padding:8px;border:1px solid #ddd;text-align:left}code{overflow-wrap:anywhere}li{margin:6px 0}</style><h1>PDF Reflow 검증 보고서</h1><p>${escapeHtml(report.sourceName)} · ${report.scope === 'preview' ? '부분 미리보기' : '전체 문서'} · ${report.sourcePages} → ${report.outputPages}쪽</p><p>원본 SHA-256: <code>${escapeHtml(report.sourceHash)}</code></p><h2>검사</h2><ul>${report.checks.map((check) => `<li>${check.passed ? '통과' : '확인 필요'} · ${escapeHtml(check.name)}: ${escapeHtml(check.detail)}</li>`).join('')}</ul><h2>경고</h2><ul>${report.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('') || '<li>없음</li>'}</ul><h2>지원 한계</h2><ul>${report.limitations.map((limitation) => `<li>${escapeHtml(limitation)}</li>`).join('')}</ul><h2>내용 추적</h2><table><thead><tr><th>블록</th><th>원문 쪽</th><th>처리</th><th>출력 쪽</th></tr></thead><tbody>${report.blocks.map((block) => `<tr><td>${escapeHtml(block.id)}</td><td>${block.sourcePage}</td><td>${escapeHtml(block.route)}${block.reason ? ` · ${escapeHtml(block.reason)}` : ''}</td><td>${block.outputPages.join(', ')}</td></tr>`).join('')}</tbody></table><p>생성 ${escapeHtml(report.createdAt)} · 빌드 ${escapeHtml(report.appVersion)}</p></html>`;
      downloadFile(html, `${stem}-report.html`, 'text/html;charset=utf-8');
    }
  }

  function displayDimension(value: number) {
    return unit === 'mm'
      ? Math.round(((value * 25.4) / 72) * 10) / 10
      : Math.round(value * 100) / 100;
  }
  function presetSize(width: number, height: number) {
    return `${displayDimension(width)} × ${displayDimension(height)} ${unit}`;
  }
  function numberField(key: NumericConfig, label: string, dimensions = false, step = 1) {
    const raw = config[key];
    const displayed = dimensions ? displayDimension(raw) : Math.round(raw * 100) / 100;
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

  return (
    <div className="app-shell">
      <header className="app-header" inert={passwordRequired}>
        <a className="brand" href="#" aria-label="PDF Reflow 처음 화면">
          <span className="brand-symbol">
            <Icon name="book" size={22} />
          </span>
          <span>
            PDF <strong>Reflow</strong>
            <small>다시, 읽기 좋게.</small>
          </span>
        </a>
        <div className="header-right">
          <button
            className="mobile-settings-button"
            aria-label="읽기 환경으로 이동"
            onClick={() => jumpTo('reading-settings')}
          >
            <Icon name="settings" size={18} />
          </button>
        </div>
      </header>

      <div className="workspace" inert={passwordRequired}>
        <aside
          id="reading-settings"
          tabIndex={-1}
          className="settings-sidebar"
          aria-label="읽기본 설정"
        >
          <div className="settings-section">
            <div className="section-label">
              <span>페이지 크기</span>
              <div className="unit-toggle" aria-label="크기 단위">
                <button className={unit === 'mm' ? 'active' : ''} onClick={() => setUnit('mm')}>
                  mm
                </button>
                <button className={unit === 'pt' ? 'active' : ''} onClick={() => setUnit('pt')}>
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
              <button
                disabled={busy}
                className={`preset-card ${config.pageWidthPt === 492 && config.pageHeightPt === 546 ? 'active' : ''}`}
                onClick={() => changeConfig({ ...DEFAULT_CONFIG })}
              >
                <span className="device-shape fold" />
                <strong>Fold7</strong>
                <small>{presetSize(492, 546)}</small>
              </button>
              <button
                disabled={busy}
                className={`preset-card ${config.pageWidthPt === 360 && config.pageHeightPt === 640 ? 'active' : ''}`}
                onClick={() =>
                  changeConfig({
                    ...config,
                    pageWidthPt: 360,
                    pageHeightPt: 640,
                    marginLeftPt: 24,
                    marginRightPt: 24,
                  })
                }
              >
                <span className="device-shape phone" />
                <strong>스마트폰</strong>
                <small>{presetSize(360, 640)}</small>
              </button>
              <button
                disabled={busy}
                className={`preset-card ${config.pageWidthPt === 419.53 && config.pageHeightPt === 595.28 ? 'active' : ''}`}
                onClick={() =>
                  changeConfig({ ...config, pageWidthPt: 419.53, pageHeightPt: 595.28 })
                }
              >
                <span className="device-shape sheet" />
                <strong>A5</strong>
                <small>{presetSize(419.53, 595.28)}</small>
              </button>
            </div>
          </div>
          <div className="settings-section">
            <div className="section-label">
              <span>글과 여백</span>
            </div>
            <label className="select-field">
              <span>본문 글꼴</span>
              <select
                value={config.fontFamily}
                disabled={busy}
                onChange={(event) =>
                  changeConfig({
                    ...config,
                    fontFamily: event.target.value as LayoutConfig['fontFamily'],
                  })
                }
              >
                <option value="serif">Noto Serif · 명조</option>
                <option value="sans">Noto Sans · 고딕</option>
              </select>
            </label>
            <div className="field-pair">
              {numberField('fontSizePt', '글자 크기', false, 0.1)}
              {numberField('lineHeightPt', '줄 간격', false, 0.1)}
            </div>
            <div className="margin-settings">
              <p className="margin-settings-label">여백과 문단</p>
              <div className="field-pair">
                {numberField('marginTopPt', '위 여백', true, 0.1)}
                {numberField('marginBottomPt', '아래 여백', true, 0.1)}
                {numberField('marginLeftPt', '왼쪽 여백', true, 0.1)}
                {numberField('marginRightPt', '오른쪽 여백', true, 0.1)}
              </div>
              {numberField('paragraphGapPt', '문단 간격', false, 0.1)}
            </div>
            <div className="section-label theme-label">
              <span>종이와 글자</span>
            </div>
            <div className="theme-options">
              <button
                disabled={busy}
                className={`theme-option warm ${config.theme === 'warm' ? 'active' : ''}`}
                onClick={() => changeConfig({ ...config, theme: 'warm' })}
              >
                <span>Aa</span>따뜻한 종이{' '}
                {config.theme === 'warm' && <Icon name="check" size={13} />}
              </button>
              <button
                disabled={busy}
                className={`theme-option light ${config.theme === 'light' ? 'active' : ''}`}
                onClick={() => changeConfig({ ...config, theme: 'light' })}
              >
                <span>Aa</span>흰 종이 {config.theme === 'light' && <Icon name="check" size={13} />}
              </button>
            </div>
            <button
              className="text-button reset-button"
              disabled={busy}
              onClick={() => changeConfig({ ...DEFAULT_CONFIG })}
            >
              <Icon name="refresh" size={13} />
              기본 설정으로
            </button>
          </div>
          <button
            className="small-button mobile-return-button"
            onClick={() => jumpTo('document-workspace')}
          >
            <Icon name="up" size={15} />
            {source ? '원문과 변환으로 돌아가기' : 'PDF 선택으로 돌아가기'}
          </button>
        </aside>

        <main
          id="document-workspace"
          tabIndex={-1}
          className={`main-workspace ${source ? 'has-document' : ''}`}
        >
          <input
            ref={fileInput}
            id="pdf-file-input"
            type="file"
            accept=".pdf,application/pdf"
            className="visually-hidden"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void openFile(file);
              event.target.value = '';
            }}
          />
          <input
            ref={projectInput}
            type="file"
            accept=".reflow-project,.json,application/json"
            className="visually-hidden"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importProject(file);
              event.target.value = '';
            }}
          />

          {pendingProject && (
            <div className="restore-banner">
              <Icon name="folder" size={20} />
              <div>
                <strong>이어 읽을 작업이 있습니다.</strong>
                <span>{pendingProject.sourceName} · 원본 PDF를 열면 설정과 보정을 복원합니다.</span>
              </div>
              <button disabled={busy} className="small-button" onClick={restoreLocal}>
                작업 복원
              </button>
              <button
                className="icon-button"
                aria-label={pendingIsStored ? '저장된 작업 삭제' : '불러온 작업 닫기'}
                disabled={busy}
                onClick={() => {
                  if (pendingIsStored) void eraseSaved();
                  else {
                    setPendingProject(null);
                    setRestoreRequested(false);
                  }
                }}
              >
                <Icon name="close" size={16} />
              </button>
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
          {notice && (
            <div className="message notice-message" role="status">
              <Icon name="check" size={17} />
              <span>{notice}</span>
              <button className="icon-button" aria-label="알림 닫기" onClick={() => setNotice('')}>
                <Icon name="close" size={15} />
              </button>
            </div>
          )}
          {busy && progress && (
            <div className="progress-card" role="status" aria-live="polite">
              <div>
                <span className="spinner" />
                <strong>{progress.message}</strong>
                <span className="progress-numbers">
                  {progress.current} / {progress.total}
                </span>
                <button className="text-button" onClick={cancel}>
                  취소
                </button>
              </div>
              <progress value={fraction} max="100" aria-label="처리 진행률" />
            </div>
          )}

          {!source ? (
            <div className="welcome-screen">
              <div
                className={`upload-area ${dragging ? 'dragging' : ''}`}
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
                  <Icon name="upload" size={25} />
                </div>
                <h2>PDF를 여기에 놓아주세요</h2>
                <p>또는 파일을 선택해 시작하세요</p>
                <button
                  className="primary-button"
                  onClick={() => fileInput.current?.click()}
                  disabled={busy}
                >
                  <Icon name="folder" size={17} />
                  PDF 선택
                  <Icon name="arrow" size={17} />
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="document-heading">
                <div className="document-name">
                  <span className="file-icon">
                    <Icon name="file" size={23} />
                  </span>
                  <div>
                    <h1 title={source.name}>{source.name}</h1>
                    <p>
                      원문 {source.pageCount}쪽 <span>·</span> {reading?.blocks.length ?? 0}개 영역{' '}
                      <span>·</span> 로컬 문서
                    </p>
                  </div>
                </div>
                <div className="document-actions">
                  <button
                    className="small-button"
                    onClick={() => fileInput.current?.click()}
                    disabled={busy}
                  >
                    <Icon name="folder" size={15} />
                    다른 PDF
                  </button>
                  <button
                    className="icon-button"
                    title="문서 닫기"
                    aria-label="문서 닫기"
                    disabled={busy}
                    onClick={closeDocument}
                  >
                    <Icon name="close" size={18} />
                  </button>
                </div>
              </div>
              <div className="document-toolbar">
                <div className="tabs" role="tablist" aria-label="문서 작업">
                  <button
                    role="tab"
                    aria-selected={tab === 'preview'}
                    className={tab === 'preview' ? 'active' : ''}
                    onClick={() => setTab('preview')}
                  >
                    미리보기
                  </button>
                  <button
                    role="tab"
                    aria-selected={tab === 'review'}
                    className={tab === 'review' ? 'active' : ''}
                    onClick={() => setTab('review')}
                  >
                    영역 검토 {reviewedCount > 0 && <span>{reviewedCount}</span>}
                  </button>
                  <button
                    role="tab"
                    aria-selected={tab === 'report'}
                    className={tab === 'report' ? 'active' : ''}
                    onClick={() => setTab('report')}
                  >
                    검증 보고서
                  </button>
                </div>
                <div className="toolbar-status">
                  {result && !stale ? (
                    <>
                      <span className="status-dot" />
                      {result.report.scope === 'preview' ? '부분 미리보기' : '읽기본 생성됨'}
                    </>
                  ) : stale ? (
                    <>
                      <span className="status-dot amber" />
                      다시 변환 필요
                    </>
                  ) : (
                    <>
                      <span className="status-dot neutral" />
                      변환 준비
                    </>
                  )}
                </div>
              </div>

              {tab === 'preview' && (
                <section className="preview-panel" aria-label="PDF 미리보기">
                  <div className="viewer-columns">
                    <div className="viewer-card">
                      <div className="viewer-title">
                        <span>
                          <span className="viewer-dot" />
                          원문
                        </span>
                        <small>ORIGINAL</small>
                      </div>
                      <PdfViewer
                        data={sourceBytes}
                        page={sourcePage}
                        onPageChange={setSourcePage}
                        label="원문"
                        highlight={highlight}
                      />
                    </div>
                    <div className="viewer-card output-viewer">
                      <div className="viewer-title">
                        <span>
                          <span className="viewer-dot warm-dot" />
                          읽기본{' '}
                          {result?.report.scope === 'preview' && (
                            <b className="preview-badge">부분 범위</b>
                          )}
                        </span>
                        <small>
                          {config.pageWidthPt} × {config.pageHeightPt} PT
                        </small>
                      </div>
                      {result ? (
                        <>
                          <div className={stale ? 'stale-preview' : ''}>
                            <PdfViewer
                              data={result.readingPdf}
                              page={outputPage}
                              onPageChange={setOutputPage}
                              label="읽기본"
                            />
                          </div>
                          {stale && (
                            <div className="stale-notice">
                              <Icon name="refresh" size={15} />
                              설정이 바뀌었습니다. 다시 변환해 주세요.
                            </div>
                          )}
                        </>
                      ) : (
                        <div className="empty-output">
                          <span className="paper-outline">
                            <span />
                            <span />
                            <span />
                            <span />
                            <span />
                          </span>
                          <h3>나에게 맞는 읽기본</h3>
                          <p>
                            왼쪽에서 읽기 환경을 정한 뒤<br />
                            아래 ‘전체 변환’을 눌러주세요.
                          </p>
                          <span className="output-size">
                            {config.pageWidthPt} × {config.pageHeightPt} pt · {config.fontSizePt} pt
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="preview-caption">
                    <Icon name="shield" size={14} />
                    <span>
                      수식·도표와 판독이 불확실한 영역은 원형을 보존합니다. 중요한 문서는 원문과
                      대조해 주세요.
                    </span>
                  </div>
                </section>
              )}

              {tab === 'review' && (
                <section className="review-panel">
                  <div className="panel-intro">
                    <div>
                      <h2>원문과 읽기 순서를 확인하세요</h2>
                      <p>
                        영역을 선택하면 원문 위치로 이동합니다. 수동 보정은 화면 크기를 바꿔도
                        유지됩니다.
                      </p>
                    </div>
                    <span className="summary-pill">
                      원형 보존 {preserveCount} · 제외 {excludedCount}
                    </span>
                  </div>
                  <div className="review-filters">
                    <label>
                      원문 쪽{' '}
                      <select
                        value={reviewPage}
                        onChange={(event) => {
                          setReviewPage(event.target.value);
                          setReviewLimit(60);
                        }}
                      >
                        <option value="all">전체</option>
                        {source.pages.map((page) => (
                          <option key={page.number} value={page.number}>
                            {page.number}쪽
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={reviewOnly}
                        onChange={(event) => {
                          setReviewOnly(event.target.checked);
                          setReviewLimit(60);
                        }}
                      />
                      확인 권장만
                    </label>
                    <span>{visibleBlocks.length}개 영역</span>
                  </div>
                  <div className="review-grid">
                    <div className="block-list">
                      {visibleBlocks.slice(0, reviewLimit).map((block, index) => (
                        <button
                          key={block.id}
                          className={`block-row ${selectedId === block.id ? 'selected' : ''} ${block.excluded ? 'excluded' : ''}`}
                          onClick={() => selectBlock(block)}
                        >
                          <span className="block-number">{index + 1}</span>
                          <div>
                            <span className="block-kind">
                              {kindLabels[block.kind]} <small>원문 {block.sourcePage}쪽</small>
                              {block.confidence === 'review' && <i>확인 권장</i>}
                            </span>
                            <p>{block.text.slice(0, 150) || block.reason || '원문 이미지 영역'}</p>
                          </div>
                          <Icon name="chevron" size={14} />
                        </button>
                      ))}
                      {visibleBlocks.length === 0 && (
                        <p className="empty-list">표시할 영역이 없습니다.</p>
                      )}
                      {visibleBlocks.length > reviewLimit && (
                        <button
                          className="small-button more-blocks"
                          onClick={() => setReviewLimit((previous) => previous + 60)}
                        >
                          다음 60개 보기
                        </button>
                      )}
                    </div>
                    <div className="block-editor">
                      {selected ? (
                        <>
                          <div className="editor-heading">
                            <h3>선택한 영역</h3>
                            <span>원문 {selected.sourcePage}쪽</span>
                          </div>
                          <label className="select-field">
                            <span>처리 방식</span>
                            <select
                              value={selectedOverride?.kind ?? selected.kind}
                              disabled={busy}
                              onChange={(event) =>
                                changeOverride(selected.id, {
                                  kind: event.target.value as BlockKind,
                                })
                              }
                            >
                              {kindOptions.map(([kind, label]) => (
                                <option
                                  value={kind}
                                  key={kind}
                                  disabled={kind !== 'sourceRegion' && !selected.rawText.trim()}
                                >
                                  {label}
                                </option>
                              ))}
                            </select>
                          </label>
                          {(selectedOverride?.kind ?? selected.kind) === 'sourceRegion' ? (
                            <p className="preserve-explainer">
                              <Icon name="shield" size={17} />
                              원문의 이 영역을 비율 그대로 보존합니다. 영역 안의 텍스트는 본문으로
                              중복 출력하지 않습니다.
                            </p>
                          ) : (
                            <label className="text-editor-label">
                              <span>읽기본 텍스트</span>
                              <textarea
                                rows={8}
                                value={selectedOverride?.text ?? selected.text}
                                disabled={busy}
                                onChange={(event) =>
                                  changeOverride(selected.id, { text: event.target.value })
                                }
                              />
                            </label>
                          )}
                          {selected.reason && (
                            <p className="block-reason">분석 참고: {selected.reason}</p>
                          )}
                          <div className="editor-order">
                            <span>읽기 순서</span>
                            <button
                              className="small-button"
                              disabled={busy || effectiveBlocks[0]?.id === selected.id}
                              onClick={() => moveBlock(selected.id, -1)}
                            >
                              <Icon name="up" size={14} />
                              위로
                            </button>
                            <button
                              className="small-button"
                              disabled={busy || effectiveBlocks.at(-1)?.id === selected.id}
                              onClick={() => moveBlock(selected.id, 1)}
                            >
                              <Icon name="down" size={14} />
                              아래로
                            </button>
                          </div>
                          <label className="checkbox-label exclusion-control">
                            <input
                              type="checkbox"
                              checked={selectedOverride?.excluded ?? false}
                              disabled={busy}
                              onChange={(event) =>
                                changeOverride(selected.id, { excluded: event.target.checked })
                              }
                            />
                            이 영역을 출력에서 제외
                          </label>
                          <p className="field-help">제외한 내용은 검증 보고서에 기록됩니다.</p>
                          <button
                            className="text-button"
                            disabled={busy || !selectedOverride}
                            onClick={() => {
                              setOverrides((previous) => {
                                const next = { ...previous };
                                delete next[selected.id];
                                return next;
                              });
                              markChanged();
                            }}
                          >
                            이 영역 보정 초기화
                          </button>
                          <div className="selected-source">
                            <PdfViewer
                              data={sourceBytes}
                              page={sourcePage}
                              onPageChange={setSourcePage}
                              label="선택 영역 원문"
                              highlight={highlight}
                            />
                          </div>
                        </>
                      ) : (
                        <div className="editor-placeholder">
                          <Icon name="file" size={28} />
                          <h3>검토할 영역을 선택하세요</h3>
                          <p>
                            본문·원형 보존 전환, 텍스트 보정,
                            <br />
                            읽기 순서와 출력 제외를 설정합니다.
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                </section>
              )}

              {tab === 'report' && (
                <section className="report-panel">
                  {result ? (
                    <>
                      <div className="panel-intro">
                        <div>
                          <h2>변환 과정을 확인할 수 있게</h2>
                          <p>
                            자동 검사는 시각적 정확성의 보증이 아닙니다. 원문 대조 합본과 함께
                            확인해 주세요.
                          </p>
                        </div>
                        {stale && (
                          <span className="summary-pill amber-pill">이전 설정의 보고서</span>
                        )}
                      </div>
                      <div className="report-metrics">
                        <div>
                          <span>원문 → 읽기본</span>
                          <strong>
                            {result.report.sourcePages}
                            <small> → </small>
                            {result.report.outputPages}
                            <small>쪽</small>
                          </strong>
                        </div>
                        <div>
                          <span>본문 재조판</span>
                          <strong>
                            {result.report.reflowedBlocks}
                            <small>개 영역</small>
                          </strong>
                        </div>
                        <div>
                          <span>원형 보존</span>
                          <strong>
                            {result.report.preservedBlocks}
                            <small>개 영역</small>
                          </strong>
                        </div>
                        <div>
                          <span>출력 범위</span>
                          <strong className="scope-metric">
                            {result.report.scope === 'full' ? '전체 문서' : '부분 미리보기'}
                          </strong>
                        </div>
                      </div>
                      <div className="report-checks">
                        {result.report.checks.map((check, index) => (
                          <div
                            className={`report-check ${check.passed ? 'passed' : 'needs-check'}`}
                            key={`${check.name}-${index}`}
                          >
                            <span className="check-circle">
                              <Icon name={check.passed ? 'check' : 'alert'} size={15} />
                            </span>
                            <div>
                              <strong>{check.name}</strong>
                              <p>{check.detail}</p>
                            </div>
                            <span>{check.passed ? '통과' : '확인 필요'}</span>
                          </div>
                        ))}
                      </div>
                      <div className="report-details">
                        <h3>
                          확인할 사항 <span>{result.report.warnings.length}</span>
                        </h3>
                        {result.report.warnings.length ? (
                          <ul>
                            {result.report.warnings.map((warning, index) => (
                              <li key={index}>{warning}</li>
                            ))}
                          </ul>
                        ) : (
                          <p>기록된 경고가 없습니다.</p>
                        )}
                        <h3>지원 한계</h3>
                        <ul>
                          {result.report.limitations.map((limitation, index) => (
                            <li key={index}>{limitation}</li>
                          ))}
                        </ul>
                        <details>
                          <summary>원문 → 출력 추적표</summary>
                          <div className="report-table-wrap">
                            <table>
                              <thead>
                                <tr>
                                  <th>블록</th>
                                  <th>원문</th>
                                  <th>처리</th>
                                  <th>출력 쪽</th>
                                </tr>
                              </thead>
                              <tbody>
                                {result.report.blocks.map((block) => (
                                  <tr key={block.id}>
                                    <td>
                                      <button
                                        className="text-button"
                                        onClick={() => {
                                          const target = reading?.blocks.find(
                                            (b) => b.id === block.id,
                                          );
                                          if (target) {
                                            selectBlock(target);
                                            setTab('review');
                                          }
                                        }}
                                      >
                                        {block.id}
                                      </button>
                                    </td>
                                    <td>{block.sourcePage}쪽</td>
                                    <td title={block.reason}>{block.route}</td>
                                    <td>{block.outputPages.join(', ') || '제외'}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </details>
                        <div className="report-identity">
                          <span>SHA-256</span>
                          <code>{result.report.sourceHash}</code>
                          <span>
                            생성 시각{' '}
                            {new Date(result.report.createdAt).toLocaleString('ko-KR', {
                              timeZone: 'Asia/Seoul',
                            })}{' '}
                            (KST)
                          </span>
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="report-empty">
                      <Icon name="check" size={30} />
                      <h2>변환 후 보고서가 여기에 표시됩니다.</h2>
                      <p>처리 범위, 원형 보존 영역, 배치 검사와 원문 연결을 확인할 수 있습니다.</p>
                    </div>
                  )}
                </section>
              )}

              <div className="conversion-bar">
                <div className="conversion-note">
                  <Icon name="book" size={23} />
                  <div>
                    <strong>
                      {stale
                        ? '바뀐 설정으로 다시 조판하세요'
                        : result
                          ? `${result.report.outputPages}쪽 읽기본이 준비되었습니다`
                          : '내 화면에 맞는 PDF를 만드세요'}
                    </strong>
                    <span>{source.pageCount}쪽 전체 내용 처리 · 수식과 도표 원형 보존</span>
                  </div>
                </div>
                <button
                  className="primary-button convert-button"
                  disabled={busy}
                  onClick={() => void runConvert()}
                >
                  <span>전체 변환</span>
                  <Icon name="arrow" size={18} />
                </button>
              </div>
              <details className="preview-range">
                <summary>일부 쪽수만 먼저 시험하기</summary>
                <div>
                  <label htmlFor="preview-range-input">원문 쪽수</label>
                  <input
                    id="preview-range-input"
                    value={range}
                    disabled={busy}
                    onChange={(event) => setRange(event.target.value)}
                    placeholder="1-3, 5"
                  />
                  <button
                    className="small-button"
                    disabled={busy}
                    onClick={() => void runConvert(true)}
                  >
                    범위 미리보기
                  </button>
                  <span>부분 출력에는 preview 표시가 붙습니다.</span>
                </div>
              </details>
              {result && (
                <div className={`downloads-panel ${stale ? 'disabled-downloads' : ''}`}>
                  <div>
                    <h3>읽을 준비가 끝났다면</h3>
                    <p>
                      {stale
                        ? '다시 변환한 뒤 새 결과를 저장할 수 있습니다.'
                        : `파일을 저장해 언제든 꺼내 읽으세요.${result.report.scope === 'preview' ? ' 현재 결과는 부분 미리보기입니다.' : ''}`}
                    </p>
                  </div>
                  <div className="download-buttons">
                    <button
                      className="download-button"
                      disabled={stale || busy}
                      onClick={() => downloadResult('reading')}
                    >
                      <Icon name="download" size={17} />
                      <span>
                        읽기본 PDF<small>{humanBytes(result.readingPdf.byteLength)}</small>
                      </span>
                    </button>
                    <button
                      className="download-button"
                      disabled={stale || busy}
                      onClick={() => downloadResult('comparison')}
                    >
                      <Icon name="download" size={17} />
                      <span>
                        원문 대조 합본<small>{humanBytes(result.comparisonPdf.byteLength)}</small>
                      </span>
                    </button>
                    <button
                      className="small-button"
                      disabled={stale || busy}
                      onClick={() => downloadResult('html')}
                    >
                      보고서 HTML
                    </button>
                    <button
                      className="small-button"
                      disabled={stale || busy}
                      onClick={() => downloadResult('json')}
                    >
                      JSON
                    </button>
                  </div>
                </div>
              )}
              <div className="project-bar">
                <div>
                  <Icon name="save" size={15} />
                  <span>{lastSaved ? '이 브라우저에 저장됨' : '다음에도 이어서 작업하세요'}</span>
                </div>
                <div>
                  <button className="text-button" disabled={busy} onClick={() => void saveLocal()}>
                    작업 저장
                  </button>
                  <button className="text-button" disabled={busy} onClick={exportProject}>
                    작업 내보내기
                  </button>
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => projectInput.current?.click()}
                  >
                    작업 가져오기
                  </button>
                  {storedProjectExists && (
                    <button
                      className="text-button muted"
                      disabled={busy}
                      onClick={() => void eraseSaved()}
                    >
                      저장 삭제
                    </button>
                  )}
                </div>
                <p>작업에는 설정·보정·추출 텍스트가 포함됩니다. 원본 PDF는 저장하지 않습니다.</p>
              </div>
            </>
          )}
        </main>
      </div>

      {passwordRequired && (
        <div className="modal-backdrop">
          <section
            className="dialog-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="password-heading"
          >
            <button
              className="icon-button dialog-close"
              aria-label="암호 입력 닫기"
              onClick={() => {
                setPasswordRequired(false);
                setPassword('');
              }}
            >
              <Icon name="close" />
            </button>
            <Icon name="shield" size={27} />
            <h2 id="password-heading">PDF 암호가 필요합니다</h2>
            <p>암호는 파일을 여는 데만 사용하며 저장하지 않습니다.</p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (pendingFile) void openFile(pendingFile, password);
              }}
            >
              <label className="password-field">
                문서 암호
                <input
                  autoFocus
                  type="password"
                  autoComplete="off"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              <button className="primary-button" disabled={busy || !password} type="submit">
                {busy ? '확인 중…' : 'PDF 열기'}
                <Icon name="arrow" size={17} />
              </button>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}

export default App;
