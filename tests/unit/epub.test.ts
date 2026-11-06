import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildEpub } from '../../src/adapters/epub/package';
import type { EpubAssets } from '../../src/adapters/epub/package';
import { DEFAULT_CONFIG } from '../../src/core/config';
import { normalizedLength } from '../../src/core/inline-content';
import type { ReadingBlock, ReadingDocument, SourceDocument } from '../../src/core/model';

const modified = new Date('2026-11-06T03:04:05.000Z');
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

function source(name = 'Research & reading.pdf'): SourceDocument {
  return {
    schemaVersion: 1,
    hash: 'a'.repeat(64),
    name,
    pageCount: 2,
    pages: [1, 2].map((number) => ({
      number,
      width: 600,
      height: 800,
      rotation: 0,
      items: [],
      graphicRegions: [],
      warnings: [],
    })),
    engine: 'synthetic',
  };
}

function block(id: string, text: string, overrides: Partial<ReadingBlock> = {}): ReadingBlock {
  return {
    id,
    kind: 'paragraph',
    text,
    rawText: text,
    sourcePage: 1,
    sourceIds: [id],
    rect: { x: 30, y: 60, width: 400, height: 12 },
    fontSize: 10,
    confidence: 'high',
    ...overrides,
  };
}

function reading(
  blocks: ReadingBlock[],
  overrides: Partial<ReadingDocument> = {},
): ReadingDocument {
  return { schemaVersion: 1, sourceHash: source().hash, blocks, warnings: [], ...overrides };
}

function assets(overrides: Partial<EpubAssets> = {}): EpubAssets {
  return { images: new Map(), modified, ...overrides };
}

function unpack(blocks: ReadingBlock[], resources = assets(), document = source()) {
  const data = buildEpub(document, reading(blocks), DEFAULT_CONFIG, resources);
  const files = unzipSync(data);
  return { data, files, text: (path: string) => strFromU8(files[path]) };
}

describe('reflowable EPUB export', () => {
  it.each([10, 20])('keeps a 1.5 line-spacing ratio when the body font is %i pt', (fontSizePt) => {
    const bytes = buildEpub(
      source(),
      reading([
        block('heading', 'A chapter heading', { kind: 'heading' }),
        block('body', 'A readable paragraph.'),
      ]),
      { ...DEFAULT_CONFIG, fontSizePt, lineHeightPercent: 150 },
      assets(),
    );
    const css = strFromU8(unzipSync(bytes)['EPUB/styles.css']);
    const body = css.match(/body\{([^}]+)\}/u)![1];
    expect(body).toContain('line-height:1.5;');
    const relativeSize = Number(body.match(/font-size:([\d.]+)em/u)![1]);
    expect(relativeSize).toBeCloseTo(fontSizePt / DEFAULT_CONFIG.fontSizePt, 3);
    const headings = css.match(/h2,h3,h4,h5,h6\{([^}]+)\}/u)![1];
    expect(headings).not.toContain('line-height:');
  });

  it('writes the required first uncompressed mimetype entry, package and navigation', () => {
    const { data, files, text } = unpack([block('body', 'A readable paragraph.')]);
    const header = new DataView(data.buffer, data.byteOffset, data.byteLength);
    expect(header.getUint32(0, true)).toBe(0x04034b50);
    expect(header.getUint16(8, true)).toBe(0);
    expect(header.getUint16(26, true)).toBe(8);
    expect(header.getUint16(28, true)).toBe(0);
    expect(strFromU8(data.subarray(30, 38))).toBe('mimetype');
    expect(strFromU8(files.mimetype)).toBe('application/epub+zip');
    expect(text('META-INF/container.xml')).toContain('full-path="EPUB/package.opf"');
    expect(text('EPUB/package.opf')).toContain('Research &amp; reading');
    expect(text('EPUB/package.opf')).toContain(
      '<meta property="dcterms:modified">2026-11-06T03:04:05Z</meta>',
    );
    expect(text('EPUB/package.opf')).toContain('properties="nav"');
    expect(text('EPUB/package.opf')).toContain('<itemref idref="chapter1"/>');
    expect(text('EPUB/nav.xhtml')).toContain('href="text/chapter-0001.xhtml#b1"');
    expect(text('EPUB/text/chapter-0001.xhtml')).toContain('A readable paragraph.');
  });

  it('reflows across source pages and omits running titles and original line numbers', () => {
    const { files, text } = unpack([
      block('head', 'A repeated running title', { running: 'header' }),
      block('first', 'The first page paragraph.'),
      block('line', '120', { kind: 'lineNumber' }),
      block('second', 'The following page paragraph.', { sourcePage: 2 }),
      block('folio', '2', { running: 'footer', runningPageNumber: true }),
    ]);
    expect(Object.keys(files).filter((path) => path.startsWith('EPUB/text/'))).toHaveLength(1);
    const chapter = text('EPUB/text/chapter-0001.xhtml');
    expect(chapter).not.toContain('A repeated running title');
    expect(chapter).not.toContain('>120<');
    expect(chapter).toContain('The first page paragraph.');
    expect(chapter).toContain('The following page paragraph.');
    expect(chapter).toContain('id="page-1" epub:type="pagebreak"');
    expect(chapter).toContain('id="page-2" epub:type="pagebreak"');
    expect(text('EPUB/nav.xhtml')).toContain('epub:type="page-list" hidden="hidden"');
    expect(text('EPUB/styles.css')).not.toMatch(/break-before\s*:/u);
    expect(text('EPUB/styles.css')).not.toContain('pt;');
    expect(text('EPUB/styles.css')).not.toContain('mm;');
  });

  it('keeps inline formula shapes, baseline and surrounding prose without duplicating math', () => {
    const value = 'Coefficient R² stays readable.';
    const start = value.indexOf('R²');
    const math = {
      start,
      end: start + 2,
      sourceIds: ['formula'],
      rect: { x: 100, y: 80, width: 12, height: 13.5 },
      baselineY: 89,
      fontSize: 10,
    };
    const { files, text } = unpack(
      [block('body', value, { inlineMath: [math] })],
      assets({
        images: new Map([
          [
            `body:math:${start}`,
            { path: 'images/math-1.png', bytes: png, width: 12, height: 13.5, baseline: 9 },
          ],
          ['unused', { path: 'images/unused.png', bytes: png, width: 10, height: 10 }],
        ]),
      }),
    );
    const chapter = text('EPUB/text/chapter-0001.xhtml');
    expect(chapter).toContain('Coefficient <img class="inline-math"');
    expect(chapter).toContain(
      'alt="R²" style="width:1.2em;vertical-align:-0.45em;"/> stays readable.',
    );
    expect(chapter.match(/R²/gu)).toHaveLength(1);
    expect(files['EPUB/images/math-1.png']).toEqual(png);
    expect(files['EPUB/images/unused.png']).toBeUndefined();
    expect(text('EPUB/package.opf')).toContain('href="images/math-1.png" media-type="image/png"');
  });

  it('keeps scanned and source-region images without inventing searchable body text', () => {
    const { files, text } = unpack(
      [block('scan', '', { kind: 'sourceRegion' })],
      assets({
        images: new Map([
          ['scan', { path: 'images/scan.png', bytes: png, width: 600, height: 800 }],
        ]),
      }),
    );
    const chapter = text('EPUB/text/chapter-0001.xhtml');
    expect(chapter).toContain('src="../images/scan.png"');
    expect(chapter).toContain('alt="Source page 1"');
    expect(files['EPUB/images/scan.png']).toEqual(png);
    expect(chapter).not.toContain('<p ');
  });

  it('keeps small preserved objects at their natural text scale instead of filling the column', () => {
    const { text } = unpack(
      [block('small', 'x', { kind: 'sourceRegion', fontSize: 10 })],
      assets({
        images: new Map([
          ['small', { path: 'images/small.png', bytes: png, width: 12, height: 12 }],
        ]),
      }),
    );
    expect(text('EPUB/text/chapter-0001.xhtml')).toContain('alt="x" style="width:1.2em;"');
    expect(text('EPUB/styles.css')).toContain('max-width:100%;height:auto;');
  });

  it('uses actual headings for navigation and detects Korean text language', () => {
    const { text } = unpack([
      block('title', '한국어 문서 제목', { kind: 'heading' }),
      block('body', '읽기 순서를 유지하고 문단을 다시 배치합니다.'),
      block('section', '1.2 방법', { kind: 'heading' }),
    ]);
    expect(text('EPUB/package.opf')).toContain('<dc:language>ko</dc:language>');
    expect(text('EPUB/text/chapter-0001.xhtml')).toContain('lang="ko" xml:lang="ko"');
    expect(text('EPUB/text/chapter-0001.xhtml')).toContain('<h3 id="b3"');
    expect(text('EPUB/nav.xhtml')).toContain('<h1>목차</h1>');
    expect(text('EPUB/nav.xhtml')).toContain('href="text/chapter-0001.xhtml#b3">1.2 방법</a>');
    expect(text('EPUB/nav.xhtml')).not.toContain('읽기 순서를 유지하고');
  });

  it('links note markers and backlinks across bounded reading chunks', () => {
    const blocks = [
      block('first', 'Reference 1 has context.', {
        sourceSpans: [
          { sourceId: 'marker', start: 9, end: 10, rect: { x: 80, y: 60, width: 5, height: 5 } },
        ],
      }),
      ...Array.from({ length: 199 }, (_, index) =>
        block(`filler-${index}`, 'Ordinary flowing content.'),
      ),
      block('note', '1 A footnote with original content.', {
        sourcePage: 2,
        semantic: 'note',
        noteLabel: '1',
      }),
    ];
    const bytes = buildEpub(
      source(),
      reading(blocks, {
        references: [
          {
            id: 'note-link',
            source: { blockId: 'first', sourceId: 'marker', offset: 0 },
            targetBlockId: 'note',
          },
        ],
      }),
      DEFAULT_CONFIG,
      assets(),
    );
    const files = unzipSync(bytes);
    const first = strFromU8(files['EPUB/text/chapter-0001.xhtml']);
    const second = strFromU8(files['EPUB/text/chapter-0002.xhtml']);
    expect(first).toContain(
      'Reference <a id="ref1" href="chapter-0002.xhtml#b201" epub:type="noteref" role="doc-noteref">1</a> has context.',
    );
    expect(second).toContain('epub:type="footnote" role="doc-footnote"');
    expect(second).toContain('href="chapter-0001.xhtml#ref1" role="doc-backlink"');
    expect(strFromU8(files['EPUB/package.opf'])).toContain('<itemref idref="chapter2"/>');
  });

  it('keeps note links in preserved source images reachable without dangling backlinks', () => {
    const value = 'Figure labels 1 and 2.';
    const body = block('figure', value, { kind: 'sourceRegion' });
    const references = ['1', '2'].map((label) => ({
      id: `note-${label}`,
      source: { blockId: body.id, offset: normalizedLength(value.slice(0, value.indexOf(label))) },
      targetBlockId: `note-${label}`,
    }));
    const data = buildEpub(
      source(),
      reading(
        [
          body,
          block('note-1', '1 First note.', { semantic: 'note', noteLabel: '1' }),
          block('note-2', '2 Second note.', { semantic: 'note', noteLabel: '2' }),
        ],
        { references },
      ),
      DEFAULT_CONFIG,
      assets({
        images: new Map([
          ['figure', { path: 'images/figure.png', bytes: png, width: 400, height: 12 }],
        ]),
      }),
    );
    const chapter = strFromU8(unzipSync(data)['EPUB/text/chapter-0001.xhtml']);
    expect(chapter).toContain('<figure class="source-region"><img');
    expect(chapter).toContain(
      '<p class="image-references"><a id="ref1" href="#b2" epub:type="noteref" role="doc-noteref">1</a> <a id="ref2" href="#b3" epub:type="noteref" role="doc-noteref">2</a></p>',
    );
    for (const target of [...chapter.matchAll(/href="#([^"]+)"/gu)])
      expect(chapter).toContain(`id="${target[1]}"`);
  });

  it('emits every note anchor when multiple references share one inline math image', () => {
    const value = 'Formula x1,2 persists.';
    const start = value.indexOf('x1,2');
    const formula = {
      start,
      end: start + 4,
      sourceIds: ['formula'],
      rect: { x: 50, y: 60, width: 30, height: 12 },
      baselineY: 70,
      fontSize: 10,
    };
    const references = ['1', '2'].map((label) => ({
      id: `note-${label}`,
      source: { blockId: 'body', offset: normalizedLength(value.slice(0, value.indexOf(label))) },
      targetBlockId: `note-${label}`,
    }));
    const bytes = buildEpub(
      source(),
      reading(
        [
          block('body', value, { inlineMath: [formula] }),
          block('note-1', '1 First note.', { semantic: 'note', noteLabel: '1' }),
          block('note-2', '2 Second note.', { semantic: 'note', noteLabel: '2' }),
        ],
        { references },
      ),
      DEFAULT_CONFIG,
      assets({
        images: new Map([
          [`body:math:${start}`, { path: 'images/math.png', bytes: png, width: 30, height: 12 }],
        ]),
      }),
    );
    const chapter = strFromU8(unzipSync(bytes)['EPUB/text/chapter-0001.xhtml']);
    expect(chapter).toContain('Formula <img class="inline-math"');
    expect(chapter).toContain('role="doc-noteref">1</a>');
    expect(chapter).toContain('role="doc-noteref">2</a>');
    expect(chapter.match(/id="ref1"/gu)).toHaveLength(1);
    expect(chapter.match(/id="ref2"/gu)).toHaveLength(1);
    expect(chapter).toContain('href="#ref1" role="doc-backlink"');
    expect(chapter).toContain('href="#ref2" role="doc-backlink"');
  });

  it('converts text line breaks without injecting markup into a formula alt attribute', () => {
    const value = 'First R\n2 last.\nNext sentence.';
    const start = value.indexOf('R');
    const { text } = unpack(
      [
        block('body', value, {
          inlineMath: [
            {
              start,
              end: start + 3,
              sourceIds: ['math'],
              rect: { x: 10, y: 10, width: 20, height: 12 },
              baselineY: 20,
              fontSize: 10,
            },
          ],
        }),
      ],
      assets({
        images: new Map([
          [`body:math:${start}`, { path: 'images/math.png', bytes: png, width: 20, height: 12 }],
        ]),
      }),
    );
    const chapter = text('EPUB/text/chapter-0001.xhtml');
    expect(chapter).toContain('alt="R 2"');
    expect(chapter).toContain(' last.<br/>Next sentence.');
    expect(chapter).not.toContain('alt="R<br/>2"');
  });

  it('rejects conflicting image paths and nonfinite baseline metrics', () => {
    expect(() =>
      unpack(
        [
          block('first', '', { kind: 'sourceRegion' }),
          block('second', '', { kind: 'sourceRegion' }),
        ],
        assets({
          images: new Map([
            ['first', { path: 'images/shared.png', bytes: png, width: 10, height: 10 }],
            [
              'second',
              { path: 'images/shared.png', bytes: Uint8Array.from([1, 2]), width: 10, height: 10 },
            ],
          ]),
        }),
      ),
    ).toThrow(/Conflicting EPUB image path/u);
    const value = 'An R² term.';
    const start = value.indexOf('R');
    expect(() =>
      unpack(
        [
          block('math', value, {
            inlineMath: [
              {
                start,
                end: start + 2,
                sourceIds: ['formula'],
                rect: { x: 10, y: 10, width: 10, height: 10 },
                fontSize: 10,
                baselineY: 18,
              },
            ],
          }),
        ],
        assets({
          images: new Map([
            [
              `math:math:${start}`,
              { path: 'images/math.png', bytes: png, width: 10, height: 10, baseline: NaN },
            ],
          ]),
        }),
      ),
    ).toThrow(/image is missing or invalid/u);
  });

  it('escapes XML text and metadata, removes invalid control characters, and embeds font licenses', () => {
    const { files, text } = unpack(
      [block('body', 'A\u0000 <script attr="x">&\ud800 B')],
      assets({
        fonts: [{ path: 'fonts/body.ttf', bytes: Uint8Array.from([0, 1, 2]), family: 'primary' }],
        licenses: [{ path: 'META-INF/licenses/OFL-Noto.txt', bytes: Uint8Array.from([65, 66]) }],
      }),
      source('Reading <script>&".pdf'),
    );
    expect(text('EPUB/package.opf')).toContain('Reading &lt;script&gt;&amp;&quot;');
    expect(text('EPUB/text/chapter-0001.xhtml')).toContain(
      'A &lt;script attr=&quot;x&quot;&gt;&amp; B',
    );
    expect(text('EPUB/text/chapter-0001.xhtml')).not.toMatch(/[\u0000\ud800]/u);
    expect(text('EPUB/styles.css')).toContain('src:url("fonts/body.ttf")');
    expect(text('EPUB/package.opf')).toContain('href="fonts/body.ttf" media-type="font/ttf"');
    expect(files['META-INF/licenses/OFL-Noto.txt']).toEqual(Uint8Array.from([65, 66]));
    expect(text('EPUB/package.opf')).not.toContain('OFL-Noto.txt');
  });

  it('rejects missing visual assets and unsafe archive paths rather than losing content', () => {
    const scan = block('scan', '', { kind: 'sourceRegion' });
    expect(() => unpack([scan])).toThrow(/image is missing/u);
    expect(() =>
      unpack(
        [scan],
        assets({
          images: new Map([['scan', { path: '../scan.png', bytes: png, width: 10, height: 10 }]]),
        }),
      ),
    ).toThrow(/path is invalid/u);
    expect(() =>
      buildEpub(source(), reading([scan], { sourceHash: 'different' }), DEFAULT_CONFIG, assets()),
    ).toThrow(/do not match/u);
  });
});
