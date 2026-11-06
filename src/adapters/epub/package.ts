import { strToU8, zipSync } from 'fflate';
import type { Zippable } from 'fflate';
import { colorTheme } from '../../core/color-themes';
import { DEFAULT_CONFIG, validateConfig } from '../../core/config';
import { inlineContent, normalizedLength } from '../../core/inline-content';
import type {
  BlockAnchor,
  LayoutConfig,
  ReadingBlock,
  ReadingDocument,
  SourceDocument,
} from '../../core/model';

export interface EpubImage {
  path: string;
  bytes: Uint8Array;
  /** Source geometry, before raster scaling. */
  width: number;
  height: number;
  /** Baseline measured downwards from the top of the source crop. */
  baseline?: number;
  mediaType?: string;
}

export interface EpubFont {
  path: string;
  bytes: Uint8Array;
  family: 'primary' | 'korean';
  mediaType?: string;
}

export interface EpubAssets {
  /** Region: block.id. Inline formula: `${block.id}:math:${math.start}`. */
  images: Map<string, EpubImage>;
  fonts?: EpubFont[];
  /** Full archive paths outside the publication, e.g. META-INF/licenses/OFL-Noto.txt. */
  licenses?: { path: string; bytes: Uint8Array }[];
  modified?: Date;
}

interface Chapter {
  file: string;
  blocks: ReadingBlock[];
}

interface Location {
  file: string;
  id: string;
}

interface NoteLink {
  start: number;
  end: number;
  id: string;
  target: Location;
}

const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' });
const number = (value: number) => String(Math.round(value * 10000) / 10000);

function clean(text: string): string {
  return [...text]
    .filter((character) => {
      const point = character.codePointAt(0)!;
      return (
        point === 9 ||
        point === 10 ||
        point === 13 ||
        (point >= 0x20 && point <= 0xd7ff) ||
        (point >= 0xe000 && point <= 0xfffd) ||
        point >= 0x10000
      );
    })
    .join('');
}

function xml(text: string): string {
  return clean(text).replace(/[&<>"']/gu, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&apos;',
    };
    return entities[character];
  });
}

const textNode = (text: string) => xml(text).replace(/\r\n?|\n/gu, '<br/>');

function resourcePath(path: string): string {
  if (
    !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(path) ||
    path.split('/').some((part) => part === '.' || part === '..')
  )
    throw new Error('EPUB resource path is invalid.');
  return path;
}

/** Script evidence supplies a useful initial language; readers still control presentation. */
function language(text: string): string {
  const counts = [
    ['ko', (text.match(/\p{Script=Hangul}/gu) ?? []).length],
    ['ja', (text.match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu) ?? []).length * 2],
    ['zh', (text.match(/\p{Script=Han}/gu) ?? []).length],
    ['en', (text.match(/\p{Script=Latin}/gu) ?? []).length],
  ] as const;
  return [...counts].sort((a, b) => b[1] - a[1])[0][1]
    ? [...counts].sort((a, b) => b[1] - a[1])[0][0]
    : 'und';
}

function chapterChunks(blocks: ReadingBlock[]): Chapter[] {
  const chapters: Chapter[] = [];
  let current: ReadingBlock[] = [];
  let characters = 0;
  const flush = () => {
    if (!current.length) return;
    chapters.push({
      file: `chapter-${String(chapters.length + 1).padStart(4, '0')}.xhtml`,
      blocks: current,
    });
    current = [];
    characters = 0;
  };
  for (const block of blocks) {
    if (current.length && (characters + block.text.length > 100_000 || current.length >= 200))
      flush();
    current.push(block);
    characters += block.text.length;
  }
  flush();
  return chapters;
}

function rawRange(text: string, offset: number): { start: number; end: number } {
  for (const cluster of graphemes.segment(text)) {
    const end = cluster.index + cluster.segment.length;
    if (normalizedLength(text.slice(0, end)) > offset) return { start: cluster.index, end };
  }
  return { start: text.length, end: text.length };
}

function referenceRange(block: ReadingBlock, anchor: BlockAnchor): { start: number; end: number } {
  const span = anchor.sourceId
    ? block.sourceSpans?.find((entry) => entry.sourceId === anchor.sourceId)
    : undefined;
  const offset = (span?.start ?? 0) + Math.max(0, anchor.offset ?? 0);
  const range = rawRange(block.text, offset);
  const label = /^(?:\[\d+\]|\(\d+\)|\d+|[*†‡§¶])/u.exec(block.text.slice(range.start));
  if (label) range.end = range.start + label[0].length;
  return range;
}

function href(from: string, target: Location): string {
  return `${from === target.file ? '' : target.file}#${target.id}`;
}

function document(title: string, lang: string, body: string, stylesheet: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${lang}" xml:lang="${lang}">
<head><meta charset="utf-8"/><title>${xml(title)}</title><link rel="stylesheet" type="text/css" href="${stylesheet}"/></head>
<body>${body}</body></html>`;
}

function headingLevel(text: string): number {
  const section = /^\s*\d+(?:\.\d+)+\.?\s+/u.exec(text);
  return section ? Math.min(6, section[0].trim().replace(/\.$/u, '').split('.').length + 1) : 2;
}

/** Produce a self-contained, reflowable EPUB directly from the reading model. */
export function buildEpub(
  source: SourceDocument,
  reading: ReadingDocument,
  inputConfig: LayoutConfig,
  assets: EpubAssets,
): Uint8Array {
  if (source.hash !== reading.sourceHash)
    throw new Error('EPUB source and reading model do not match.');
  const config = validateConfig(inputConfig);
  const blocks = reading.blocks.filter((block) => !block.running && block.kind !== 'lineNumber');
  if (!blocks.length) throw new Error('EPUB has no reading content.');
  const title = clean(source.name.replace(/\.pdf$/iu, '')).trim() || 'Document';
  const lang = language(blocks.map((block) => block.text).join(' '));
  const modified = assets.modified ?? new Date();
  const timestamp = modified.toISOString().replace(/\.\d{3}Z$/u, 'Z');
  const chapters = chapterChunks(blocks);
  const locations = new Map<string, Location>();
  let blockNumber = 0;
  for (const chapter of chapters)
    for (const block of chapter.blocks) {
      if (locations.has(block.id)) throw new Error('EPUB reading block IDs must be unique.');
      locations.set(block.id, { file: chapter.file, id: `b${++blockNumber}` });
    }
  const byId = new Map(blocks.map((block) => [block.id, block]));
  const links = new Map<string, NoteLink[]>();
  const backlinks = new Map<string, Location[]>();
  const seenReferences = new Set<string>();
  for (const reference of reading.references ?? []) {
    const block = byId.get(reference.source.blockId);
    const target = locations.get(reference.targetBlockId);
    if (!block || !target || reference.source.blockId === reference.targetBlockId) continue;
    const range = referenceRange(block, reference.source);
    if (range.start >= range.end) continue;
    const key = `${block.id}:${range.start}:${range.end}`;
    if (seenReferences.has(key)) continue;
    seenReferences.add(key);
    const id = `ref${seenReferences.size}`;
    const existing = links.get(block.id) ?? [];
    if (existing.some((link) => link.start < range.end && link.end > range.start)) continue;
    existing.push({ ...range, id, target });
    links.set(block.id, existing);
    const reverse = backlinks.get(reference.targetBlockId) ?? [];
    reverse.push({ file: locations.get(block.id)!.file, id });
    backlinks.set(reference.targetBlockId, reverse);
  }

  const usedImages = new Map<string, EpubImage>();
  const image = (key: string): EpubImage => {
    const value = assets.images.get(key);
    if (
      !value ||
      !value.bytes.length ||
      ![value.width, value.height].every((n) => Number.isFinite(n) && n > 0) ||
      (value.baseline !== undefined && !Number.isFinite(value.baseline))
    )
      throw new Error(`EPUB image is missing or invalid: ${key}`);
    resourcePath(value.path);
    usedImages.set(key, value);
    return value;
  };
  const wrapLink = (content: string, link: NoteLink, file: string) =>
    `<a id="${link.id}" href="${href(file, link.target)}" epub:type="noteref" role="doc-noteref">${content}</a>`;
  const markerLinks = (block: ReadingBlock, references: NoteLink[], file: string) =>
    references
      .map((reference) => {
        const original = clean(block.text.slice(reference.start, reference.end)).trim();
        const note = blocks.find((entry) => locations.get(entry.id)?.id === reference.target.id);
        return wrapLink(xml(original || note?.noteLabel || '↗'), reference, file);
      })
      .join(' ');
  const renderText = (block: ReadingBlock, file: string): string => {
    const formulae = [...inlineContent(block).atoms.values()];
    const references = [...(links.get(block.id) ?? [])].sort((a, b) => a.start - b.start);
    let result = '';
    let position = 0;
    const emitted = new Set<string>();
    const plain = (start: number, end: number) => {
      let value = '';
      let cursor = start;
      for (const reference of references) {
        if (reference.start < start || reference.end > end) continue;
        value += textNode(block.text.slice(cursor, reference.start));
        const label = textNode(block.text.slice(reference.start, reference.end));
        value += emitted.has(reference.id) ? label : wrapLink(label, reference, file);
        emitted.add(reference.id);
        cursor = reference.end;
      }
      return value + textNode(block.text.slice(cursor, end));
    };
    for (const atom of formulae) {
      result += plain(position, atom.math.start);
      const value = image(`${block.id}:math:${atom.math.start}`);
      const baseline = value.baseline ?? atom.math.baselineY - atom.math.rect.y;
      const vertical = (baseline - value.height) / atom.math.fontSize;
      let markup = `<img class="inline-math" src="../${xml(value.path)}" alt="${xml(atom.text.replace(/\s+/gu, ' ').trim()) || 'Formula'}" style="width:${number(value.width / atom.math.fontSize)}em;vertical-align:${number(vertical)}em;"/>`;
      const related = references
        .filter((link) => link.start < atom.math.end && link.end > atom.math.start)
        .filter((link) => !emitted.has(link.id));
      if (related.length === 1) markup = wrapLink(markup, related[0], file);
      else if (related.length > 1)
        markup += `<span class="image-references">${markerLinks(block, related, file)}</span>`;
      related.forEach((link) => emitted.add(link.id));
      result += markup;
      position = atom.math.end;
    }
    result += plain(position, block.text.length);
    return result;
  };

  const pages = new Map<number, Location>();
  const headings: { label: string; location: Location }[] = [];
  const chapterBodies = new Map<string, string>();
  for (const chapter of chapters) {
    let content = '';
    for (const block of chapter.blocks) {
      const location = locations.get(block.id)!;
      if (!pages.has(block.sourcePage)) {
        const page = { file: chapter.file, id: `page-${block.sourcePage}` };
        pages.set(block.sourcePage, page);
        content += `<span id="${page.id}" epub:type="pagebreak" role="doc-pagebreak" aria-label="${block.sourcePage}"/>`;
      }
      const classes = [block.kind, ...(block.keepTogether ? ['keep-together'] : [])].join(' ');
      const alignment =
        block.alignment && ['left', 'right', 'center', 'justify'].includes(block.alignment)
          ? block.alignment
          : block.kind === 'paragraph'
            ? 'justify'
            : 'left';
      const style = `text-align:${alignment};`;
      const blockLang = language(block.text);
      let body: string;
      if (block.kind === 'sourceRegion') {
        const value = image(block.id);
        const width =
          block.fontSize > 0 ? `width:${number(value.width / block.fontSize)}em;` : 'width:100%;';
        body = `<figure class="source-region"><img src="../${xml(value.path)}" alt="${xml(block.text).trim() || `Source page ${block.sourcePage}`}" style="${width}"/></figure>`;
        const references = links.get(block.id) ?? [];
        if (references.length)
          body += `<p class="image-references">${markerLinks(block, references, chapter.file)}</p>`;
      } else body = renderText(block, chapter.file);
      const reverse = (backlinks.get(block.id) ?? [])
        .map(
          (target, index) =>
            `<a class="backlink" href="${href(chapter.file, target)}" role="doc-backlink" aria-label="Back to reference ${index + 1}">↩</a>`,
        )
        .join(' ');
      const attributes = `id="${location.id}" class="${xml(classes)}" lang="${blockLang}" xml:lang="${blockLang}" style="${style}"`;
      if (block.semantic === 'note' || block.kind === 'footnote')
        content += `<aside ${attributes} epub:type="footnote" role="doc-footnote">${body}${reverse ? ` <span class="backlinks">${reverse}</span>` : ''}</aside>`;
      else if (block.kind === 'heading') {
        const level = headingLevel(block.text);
        headings.push({
          label: clean(block.text).trim() || `Section ${headings.length + 1}`,
          location,
        });
        content += `<h${level} ${attributes}>${body}</h${level}>`;
      } else if (block.kind === 'list')
        content += `<ul class="list"><li ${attributes}>${body}</li></ul>`;
      else if (block.kind === 'sourceRegion') content += `<div ${attributes}>${body}</div>`;
      else content += `<p ${attributes}>${body}</p>`;
    }
    chapterBodies.set(chapter.file, document(title, lang, content, '../styles.css'));
  }

  const navigation = headings.length
    ? headings
    : chapters.map((chapter, index) => ({
        label: chapters.length === 1 ? title : `${title} (${index + 1})`,
        location: locations.get(chapter.blocks[0].id)!,
      }));
  const toc = navigation
    .map(
      ({ label, location }) =>
        `<li><a href="text/${location.file}#${location.id}">${xml(label)}</a></li>`,
    )
    .join('');
  const pageList = [...pages]
    .sort(([a], [b]) => a - b)
    .map(
      ([page, location]) => `<li><a href="text/${location.file}#${location.id}">${page}</a></li>`,
    )
    .join('');
  const nav = document(
    title,
    lang,
    `<nav epub:type="toc" id="toc"><h1>${lang === 'ko' ? '목차' : 'Contents'}</h1><ol>${toc}</ol></nav><nav epub:type="page-list" hidden="hidden"><ol>${pageList}</ol></nav>`,
    'styles.css',
  );

  const theme = colorTheme(config.theme);
  const fonts = assets.fonts ?? [];
  const fontFaces = fonts
    .map(
      (font) =>
        `@font-face{font-family:"Reflow ${font.family === 'primary' ? 'Primary' : 'Korean'}";src:url("${resourcePath(font.path)}");font-weight:normal;font-style:normal;}`,
    )
    .join('\n');
  const css = `${fontFaces}
html{background:${theme.background};color:${theme.foreground};}
body{font-family:"Reflow Primary","Reflow Korean",${config.fontFamily === 'serif' ? 'serif' : 'sans-serif'};font-size:${number(config.fontSizePt / DEFAULT_CONFIG.fontSizePt)}em;line-height:${number(config.lineHeightPt / config.fontSizePt)};margin:0;padding:0;overflow-wrap:break-word;hyphens:auto;}
p,aside{margin:0 0 ${number(config.paragraphGapPt / config.fontSizePt)}em;}
h2,h3,h4,h5,h6{line-height:1.3;margin:1em 0 .5em;break-after:avoid;page-break-after:avoid;}
h2{font-size:1.35em;}h3,h4,h5,h6{font-size:1.2em;}
.list{list-style:none;margin:0 0 ${number(config.paragraphGapPt / config.fontSizePt)}em;padding:0 0 0 1em;}
.source-region{margin:.6em 0;text-align:center;break-inside:avoid;page-break-inside:avoid;}
.source-region img{display:inline-block;max-width:100%;height:auto;}
.inline-math{display:inline-block;max-width:100%;height:auto;margin:0;}
.caption,.reference,.footnote{font-size:.92em;}.keep-together{break-inside:avoid;page-break-inside:avoid;}
a{color:inherit;}.backlink{white-space:nowrap;text-decoration:none;}.backlinks{margin-left:.35em;}
.image-references{margin:.2em 0 .6em;font-size:.85em;}.image-references a{margin-right:.35em;}
`;

  const files: Zippable = { mimetype: [strToU8('application/epub+zip'), { level: 0 }] };
  const archivePaths = new Set(['mimetype']);
  const add = (path: string, bytes: Uint8Array, stored = false) => {
    resourcePath(path);
    if (archivePaths.has(path)) throw new Error(`Duplicate EPUB resource path: ${path}`);
    archivePaths.add(path);
    files[path] = stored ? [bytes, { level: 0 }] : bytes;
  };
  add(
    'META-INF/container.xml',
    strToU8(
      '<?xml version="1.0" encoding="utf-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    ),
  );
  add('EPUB/styles.css', strToU8(css));
  add('EPUB/nav.xhtml', strToU8(nav));
  const manifest = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '<item id="css" href="styles.css" media-type="text/css"/>',
  ];
  const spine: string[] = [];
  for (const [index, chapter] of chapters.entries()) {
    add(`EPUB/text/${chapter.file}`, strToU8(chapterBodies.get(chapter.file)!));
    manifest.push(
      `<item id="chapter${index + 1}" href="text/${chapter.file}" media-type="application/xhtml+xml"/>`,
    );
    spine.push(`<itemref idref="chapter${index + 1}"/>`);
  }
  const imagePaths = new Map<string, EpubImage>();
  for (const value of usedImages.values()) {
    const existing = imagePaths.get(value.path);
    if (existing) {
      if (
        existing.bytes.length !== value.bytes.length ||
        existing.bytes.some((byte, index) => byte !== value.bytes[index])
      )
        throw new Error(`Conflicting EPUB image path: ${value.path}`);
      continue;
    }
    imagePaths.set(value.path, value);
    add(`EPUB/${value.path}`, value.bytes, true);
    manifest.push(
      `<item id="image${imagePaths.size}" href="${xml(value.path)}" media-type="${xml(value.mediaType ?? 'image/png')}"/>`,
    );
  }
  for (const [index, font] of fonts.entries()) {
    add(`EPUB/${resourcePath(font.path)}`, font.bytes);
    manifest.push(
      `<item id="font${index + 1}" href="${xml(font.path)}" media-type="${xml(font.mediaType ?? 'font/ttf')}"/>`,
    );
  }
  for (const license of assets.licenses ?? []) add(license.path, license.bytes);
  add(
    'EPUB/package.opf',
    strToU8(
      `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="publication-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="publication-id">${xml(`urn:sha256:${source.hash}`)}</dc:identifier><dc:title>${xml(title)}</dc:title><dc:language>${lang}</dc:language><meta property="dcterms:modified">${timestamp}</meta></metadata><manifest>${manifest.join('')}</manifest><spine>${spine.join('')}</spine></package>`,
    ),
  );
  return zipSync(files, { level: 6, mtime: modified });
}
