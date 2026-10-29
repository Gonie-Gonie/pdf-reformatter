import { describe, expect, it } from 'vitest';
import { attachStructure, markedContentAt } from '../../src/adapters/pdf/structure';
import type { SourcePage, SourceText } from '../../src/core/model';

type TextItems = Parameters<typeof markedContentAt>[0];
type Tree = NonNullable<Parameters<typeof attachStructure>[1]>;

function text(value: string) {
  return {
    str: value,
    dir: 'ltr',
    transform: [1, 0, 0, 1, 0, 0],
    width: 100,
    height: 12,
    fontName: 'test',
    hasEOL: false,
  };
}

function item(id: string, markedContentId?: string): SourceText {
  return {
    id,
    text: id,
    x: 36,
    y: 40,
    width: 100,
    height: 12,
    fontSize: 12,
    fontName: 'test',
    hasEOL: false,
    ...(markedContentId ? { markedContentId } : {}),
  };
}

function page(items: SourceText[]): SourcePage {
  return {
    number: 2,
    width: 612,
    height: 792,
    rotation: 0,
    items,
    graphicRegions: [],
    warnings: [],
  };
}

describe('marked content extraction', () => {
  it('inherits and restores marked identifiers through nested plain and numbered scopes', () => {
    const items = [
      { type: 'endMarkedContent' },
      text('outside'),
      { type: 'beginMarkedContentProps', id: 'p2_mc7', tag: 'P' },
      text('parent'),
      { type: 'beginMarkedContent', tag: 'Span' },
      text('plain nested'),
      { type: 'beginMarkedContentProps', id: 'p2_mc8', tag: 'Reference' },
      text('reference'),
      { type: 'endMarkedContent' },
      text('parent again'),
      { type: 'endMarkedContent' },
      { type: 'endMarkedContent' },
      text('outside again'),
    ] as TextItems;
    const metadata = markedContentAt(items);

    expect(metadata.has(1)).toBe(false);
    expect(metadata.get(3)).toEqual({ markedContentId: 'p2_mc7' });
    expect(metadata.get(5)).toEqual({ markedContentId: 'p2_mc7' });
    expect(metadata.get(7)).toEqual({ markedContentId: 'p2_mc8' });
    expect(metadata.get(9)).toEqual({ markedContentId: 'p2_mc7' });
    expect(metadata.has(12)).toBe(false);
  });

  it('retains artifacts without inventing identifiers for nullable MCIDs', () => {
    const items = [
      { type: 'beginMarkedContentProps', id: null, tag: 'Artifact' },
      text('1'),
      { type: 'beginMarkedContentProps', id: 'p2_mc1', tag: 'Span' },
      text('2'),
      { type: 'endMarkedContent' },
      { type: 'endMarkedContent' },
      text('body'),
    ] as TextItems;
    const metadata = markedContentAt(items);

    expect(metadata.get(1)).toEqual({ artifact: true });
    expect(metadata.get(3)).toEqual({ artifact: true, markedContentId: 'p2_mc1' });
    expect(metadata.has(6)).toBe(false);
  });
});

describe('source structure mapping', () => {
  it('keeps a note label and body in one logical group and preserves mapped roles', () => {
    const original = page([item('body', 'p2_mc3'), item('label', 'p2_mc2'), item('untagged')]);
    const tree: Tree = {
      role: 'Root',
      children: [
        {
          role: 'Document',
          children: [
            {
              role: 'Note',
              children: [
                { role: 'Lbl', children: [{ type: 'content', id: 'p2_mc2' }] },
                { role: 'P', children: [{ type: 'content', id: 'p2_mc3' }] },
              ],
            },
          ],
        },
      ],
    };

    attachStructure(original, tree);

    const note = original.structure?.find((group) => group.role === 'Note');
    const label = original.structure?.find((group) => group.role === 'Lbl');
    expect(note?.sourceIds).toEqual(['label', 'body']);
    expect(note?.id).toBe('p2:structure:root.0.0');
    expect(label?.parentId).toBe(note?.id);
    expect(label!.order).toBeGreaterThan(note!.order);
    expect(original.items[0].structureRoles).toEqual(['Root', 'Document', 'Note', 'P']);
    expect(original.items[1].structureRoles).toEqual(['Root', 'Document', 'Note', 'Lbl']);
    expect(original.items[2].structureRoles).toBeUndefined();
  });

  it('tolerates missing content references and ignores non-text object references', () => {
    const original = page([
      item('entry', 'p2_mc5'),
      { ...item('line-number', 'p2_mc5'), artifact: true },
    ]);
    const tree: Tree = {
      role: 'Root',
      children: [
        { role: 'TOCI', children: [{ type: 'content', id: 'p2_mc5' }] },
        { role: 'TOCI', children: [{ type: 'content', id: 'missing' }] },
        { type: 'object', id: 'p2_mc5' },
      ],
    };
    attachStructure(original, tree);

    expect(original.structure?.filter((group) => group.role === 'TOCI')).toHaveLength(1);
    expect(original.structure?.find((group) => group.role === 'TOCI')?.sourceIds).toEqual([
      'entry',
    ]);
    expect(original.items[0].structureRoles).toEqual(['Root', 'TOCI']);
    expect(original.items[1].structureRoles).toBeUndefined();
    expect(original.items).toHaveLength(2);
  });

  it('returns to geometry-only data when optional structure is absent or malformed', () => {
    const original = page([item('body', 'p2_mc1')]);
    attachStructure(original, { role: 'P', children: [{ type: 'content', id: 'p2_mc1' }] });
    expect(original.items[0].structureRoles).toEqual(['P']);
    original.items[0].artifact = true;

    attachStructure(original, null);
    expect(original.structure).toBeUndefined();
    expect(original.items[0].structureRoles).toBeUndefined();
    expect(original.items[0].markedContentId).toBe('p2_mc1');
    expect(original.items[0].artifact).toBe(true);
    attachStructure(original, {
      role: 'Root',
      children: [null, { role: 'Note' }],
    } as unknown as Tree);
    expect(original.structure).toBeUndefined();
    expect(original.items[0].text).toBe('body');
  });
});
