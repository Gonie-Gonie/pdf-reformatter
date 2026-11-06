import { describe, expect, it } from 'vitest';
import { codeBlockEntries } from '../../src/core/code-blocks';
import { analyzePageSemantics } from '../../src/core/semantics';
import type { SourcePage, SourceText } from '../../src/core/model';

function item(
  id: string,
  text: string,
  x: number,
  y: number,
  fontName = 'monospace g_d0_f3',
): SourceText {
  return {
    id,
    text,
    x,
    y,
    width: text.length * 6,
    height: 10,
    fontSize: 10,
    baselineY: y + 8,
    fontName,
    hasEOL: true,
  };
}
function page(items: SourceText[]): SourcePage {
  return {
    number: 1,
    width: 612,
    height: 792,
    rotation: 0,
    items,
    graphicRegions: [],
    warnings: [],
  };
}

describe('source code blocks', () => {
  it('preserves indentation and blank lines as one crop with unique ownership', () => {
    const lines = [
      item('map', 'known = {0:0, 1:1}', 60, 100),
      item('def', 'def fibonacci(n):', 60, 124),
      item('if', 'if n in known:', 84, 136),
      item('cached', 'return known[n]', 108, 148),
      item('sum', 'res = fibonacci(n-1) + fibonacci(n-2)', 84, 172),
      item('store', 'known[n] = res', 84, 184),
      item('return', 'return res', 84, 196),
    ];
    const source = page([
      item('before', 'The following function caches its results.', 60, 80, 'serif'),
      ...lines,
      item('after', 'The dictionary records previously computed values.', 60, 218, 'serif'),
    ]);
    const entries = codeBlockEntries(source);
    expect(entries).toHaveLength(1);
    expect(entries[0].items.map((entry) => entry.id)).toEqual(lines.map((entry) => entry.id));
    expect(entries[0].rawText).toBe(
      'known = {0:0, 1:1}\n\ndef fibonacci(n):\n    if n in known:\n        return known[n]\n\n    res = fibonacci(n-1) + fibonacci(n-2)\n    known[n] = res\n    return res',
    );
    const semantic = analyzePageSemantics(source).blocks.find((block) =>
      block.id.includes(':code:'),
    )!;
    expect(semantic).toMatchObject({ kind: 'sourceRegion', keepTogether: true });
    expect(semantic.sourceIds).toEqual(lines.map((entry) => entry.id));
    expect(semantic.sourceSpans?.map((span) => span.sourceId)).toEqual(semantic.sourceIds);
    expect(new Set(semantic.sourceIds).size).toBe(lines.length);
  });

  it.each(['Courier New', 'LMMono10-Regular', 'Consolas'])(
    'recognizes %s without language-specific parsing',
    (font) => {
      const source = page([
        item('open', 'for (int i = 0; i < count; i++) {', 60, 100, font),
        item('call', 'values[i] += update(i);', 84, 112, font),
        item('close', '}', 60, 124, font),
      ]);
      expect(codeBlockEntries(source)).toHaveLength(1);
    },
  );

  it('keeps mixed-font inline code in prose and isolated code words out of code crops', () => {
    const source = page([
      item('a', 'Call', 60, 100, 'serif'),
      item('inline-a', 'update(i)', 90, 100),
      item('b', 'before returning a result.', 150, 100, 'serif'),
      item('c', 'The value', 60, 112, 'serif'),
      item('inline-b', 'n=4', 120, 112),
      item('d', 'is the initial argument.', 144, 112, 'serif'),
      item('word-a', 'identifier', 60, 160),
      item('word-b', 'parameter', 60, 172),
    ]);
    expect(codeBlockEntries(source)).toEqual([]);
  });

  it('does not split monospace labels out of a diagram', () => {
    const source = page([
      item('call', 'evaluate(x)', 100, 100),
      item('value', 'x = 4', 100, 116),
      item('return', 'return x', 100, 132),
    ]);
    source.graphicRegions = [{ x: 90, y: 90, width: 160, height: 65 }];
    expect(codeBlockEntries(source)).toEqual([]);
  });

  it('respects an already-owned structure and separates code interrupted by prose', () => {
    const source = page([
      item('a', 'x = update(1);', 60, 100),
      item('b', 'return x;', 60, 112),
      item('explain', 'A new example follows.', 60, 126, 'serif'),
      item('c', 'y = update(2);', 60, 140),
      item('d', 'return y;', 60, 152),
    ]);
    expect(codeBlockEntries(source).map((entry) => entry.items.map((text) => text.id))).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(codeBlockEntries(source, new Set(['a', 'b'])).map((entry) => entry.id)).toEqual(['c']);
  });

  it('preserves multiline numeric terminal output', () => {
    const source = page([
      item('three', '3', 60, 100),
      item('two', '2', 60, 112),
      item('one', '1', 60, 124),
      item('message', 'Blastoff!', 60, 136),
    ]);
    expect(codeBlockEntries(source)[0].rawText).toBe('3\n2\n1\nBlastoff!');
  });
});

describe('spaced contents leaders', () => {
  it('keeps a hanging title, spaced leaders and reference together without rewriting source text', () => {
    const source = page([
      item('heading', 'Contents', 60, 60, 'serif'),
      item('long', '1 A chapter title that continues', 60, 100, 'serif'),
      item('continued', 'on a second line . . . . . . 12', 78, 114, 'serif'),
      item('next', '2 Another chapter . . . . . . 24', 60, 142, 'serif'),
    ]);
    const contents = analyzePageSemantics(source).blocks.filter(
      (block) => block.semantic === 'toc',
    );
    expect(contents).toHaveLength(2);
    expect(contents[0].sourceIds).toEqual(['long', 'continued']);
    expect(contents[0].rawText).toContain('. . . . . . 12');
    expect(contents[1].sourceIds).toEqual(['next']);
  });

  it('recognizes untagged leaders with separately positioned page numbers', () => {
    const source = page(
      ['First chapter', 'Second chapter', 'Third chapter'].flatMap((title, index) => [
        item(`title-${index}`, `${title} . . . . . . . .`, 60, 100 + index * 20, 'serif'),
        item(`number-${index}`, String(index + 1), 505, 100 + index * 20, 'serif'),
      ]),
    );
    const contents = analyzePageSemantics(source).blocks.filter(
      (block) => block.semantic === 'toc',
    );
    expect(contents).toHaveLength(3);
    contents.forEach((entry, index) => {
      expect(entry.sourceIds).toEqual([`title-${index}`, `number-${index}`]);
      expect(entry.rawText).toContain('. . . . . . . .');
    });
  });

  it('keeps a separate chapter label with its title and does not absorb a section heading', () => {
    const source = page([
      item('heading', 'Contents', 60, 60, 'serif'),
      item('chapter-label', '1', 60, 100, 'serif'),
      item('chapter-title', 'The first chapter', 78, 100, 'serif'),
      item('chapter-page', '1', 505, 100, 'serif'),
      item('section', '1.1 The first section . . . . 2', 78, 120, 'serif'),
      item('part', 'Chapter Two: Linear Systems', 60, 148, 'serif'),
      item('roman-section', 'I Solving systems . . . . 20', 78, 162, 'serif'),
    ]);
    const contents = analyzePageSemantics(source).blocks.filter(
      (block) => block.semantic === 'toc',
    );
    expect(contents.map((block) => block.sourceIds)).toEqual([
      ['chapter-label', 'chapter-title', 'chapter-page'],
      ['section'],
      ['roman-section'],
    ]);
  });

  it('does not interpret several numbered function frames in a diagram as a contents page', () => {
    const source = page(
      [100, 120, 140].flatMap((y, index) => [
        item(`function-${index}`, 'evaluate', 300, y, 'serif'),
        item(`value-${index}`, String(index), 500, y, 'serif'),
      ]),
    );
    source.graphicRegions = [{ x: 290, y: 90, width: 230, height: 70 }];
    expect(analyzePageSemantics(source).blocks.filter((block) => block.semantic === 'toc')).toEqual(
      [],
    );
  });
});
