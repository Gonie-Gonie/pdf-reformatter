import { validateConfig } from '../../core/config';
import type { BlockKind, ReadingBlock, SavedProject } from '../../core/model';

const kinds: BlockKind[] = [
  'heading',
  'paragraph',
  'list',
  'caption',
  'footnote',
  'reference',
  'sourceRegion',
];
const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);
const validString = (x: unknown, max = 2_000_000): x is string =>
  typeof x === 'string' && x.length <= max;
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
function validateBlock(value: unknown): value is ReadingBlock {
  if (!isObject(value) || !isObject(value.rect)) return false;
  const r = value.rect;
  return (
    validString(value.id, 256) &&
    value.id.length > 0 &&
    kinds.includes(value.kind as BlockKind) &&
    finite(value.sourcePage) &&
    Number.isInteger(value.sourcePage) &&
    value.sourcePage > 0 &&
    Array.isArray(value.sourceIds) &&
    value.sourceIds.length <= 100_000 &&
    value.sourceIds.every((id) => validString(id, 256)) &&
    ['x', 'y', 'width', 'height'].every(
      (key) => finite(r[key]) && (r[key] as number) >= 0 && (r[key] as number) <= 100_000,
    ) &&
    (r.width as number) > 0 &&
    (r.height as number) > 0 &&
    validString(value.rawText) &&
    validString(value.text) &&
    finite(value.fontSize) &&
    value.fontSize > 0 &&
    value.fontSize <= 100_000 &&
    (value.confidence === 'high' || value.confidence === 'review') &&
    (value.reason === undefined || validString(value.reason, 4000))
  );
}
export function parseProject(text: string): SavedProject {
  if (text.length > 30_000_000) throw new Error('작업 파일은 30MB 이하만 지원합니다.');
  const p: unknown = JSON.parse(text);
  if (!isObject(p) || p.schemaVersion !== 1)
    throw new Error('지원하지 않는 작업 파일 버전입니다. 원본 파일은 변경되지 않았습니다.');
  if (
    !validString(p.sourceHash, 64) ||
    !/^[a-f0-9]{64}$/.test(p.sourceHash) ||
    !validString(p.sourceName, 1024) ||
    !isObject(p.reading) ||
    p.reading.schemaVersion !== 1 ||
    p.reading.sourceHash !== p.sourceHash ||
    !Array.isArray(p.reading.blocks) ||
    p.reading.blocks.length > 100_000 ||
    !p.reading.blocks.every(validateBlock) ||
    !Array.isArray(p.reading.warnings) ||
    p.reading.warnings.length > 100_000 ||
    !p.reading.warnings.every((w) => validString(w, 4000)) ||
    !isObject(p.overrides) ||
    !validString(p.savedAt, 64) ||
    !Number.isFinite(Date.parse(p.savedAt))
  ) {
    throw new Error('작업 파일의 구조나 원본 해시가 올바르지 않습니다.');
  }
  const ids = new Set(p.reading.blocks.map((b) => (b as ReadingBlock).id));
  if (ids.size !== p.reading.blocks.length) throw new Error('작업 파일에 중복 블록이 있습니다.');
  for (const [id, value] of Object.entries(p.overrides)) {
    if (
      !ids.has(id) ||
      !isObject(value) ||
      (value.kind !== undefined && !kinds.includes(value.kind as BlockKind)) ||
      (value.text !== undefined && !validString(value.text)) ||
      (value.excluded !== undefined && typeof value.excluded !== 'boolean') ||
      (value.order !== undefined && !finite(value.order))
    )
      throw new Error('작업 파일의 보정 내용이 올바르지 않습니다.');
  }
  return {
    schemaVersion: 1,
    sourceHash: p.sourceHash,
    sourceName: p.sourceName,
    config: validateConfig(p.config),
    reading: p.reading as unknown as SavedProject['reading'],
    overrides: p.overrides as SavedProject['overrides'],
    savedAt: p.savedAt,
  };
}

const databaseName = `pdf-reflow:${import.meta.env.BASE_URL}`;
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('projects');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        new Error('브라우저 작업 저장소를 열 수 없습니다. 작업 파일을 내려받아 보관해 주세요.'),
      );
    request.onblocked = () =>
      reject(new Error('다른 탭에서 저장소를 사용 중입니다. 다른 탭을 닫고 다시 시도해 주세요.'));
  });
}
export async function saveProject(project: SavedProject): Promise<void> {
  const validated = parseProject(JSON.stringify(project));
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction('projects', 'readwrite');
      tx.objectStore('projects').put(validated, 'current');
      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject(
          new Error(
            '작업 저장에 실패했습니다. 저장 공간을 확인하거나 작업 파일을 내려받아 주세요.',
          ),
        );
      tx.onabort = () =>
        reject(new Error('작업 저장이 중단되었습니다. 작업 파일을 내려받아 보관해 주세요.'));
    });
  } finally {
    database.close();
  }
}
export async function loadProject(): Promise<SavedProject | null> {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = database.transaction('projects', 'readonly');
      const request = tx.objectStore('projects').get('current');
      request.onsuccess = () => {
        try {
          resolve(request.result ? parseProject(JSON.stringify(request.result)) : null);
        } catch (error) {
          reject(error);
        }
      };
      request.onerror = () => reject(new Error('저장된 작업을 읽을 수 없습니다.'));
    });
  } finally {
    database.close();
  }
}
export async function deleteProject(): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction('projects', 'readwrite');
      tx.objectStore('projects').delete('current');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new Error('저장된 작업 삭제에 실패했습니다.'));
    });
  } finally {
    database.close();
  }
}
export function downloadFile(data: Uint8Array | string, filename: string, mime: string): void {
  const safeName =
    filename.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').slice(0, 180) ||
    'pdf-reflow-download';
  const blob = new Blob([typeof data === 'string' ? data : data.slice().buffer], { type: mime });
  const url = URL.createObjectURL(blob),
    link = document.createElement('a');
  link.href = url;
  link.download = safeName;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
