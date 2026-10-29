import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/core/config';
import type { SavedProject } from '../../src/core/model';
import { parseProject } from '../../src/adapters/storage/project';

function project(): SavedProject {
  const hash = 'a'.repeat(64);
  return {
    schemaVersion: 1,
    sourceHash: hash,
    sourceName: '합성 문서.pdf',
    config: { ...DEFAULT_CONFIG },
    reading: {
      schemaVersion: 1,
      sourceHash: hash,
      warnings: ['원문 대조 필요'],
      blocks: [
        {
          id: 'p1-b1',
          kind: 'paragraph',
          sourcePage: 1,
          sourceIds: ['p1-t1'],
          rect: { x: 12, y: 24, width: 300, height: 40 },
          rawText: 'Original text. 원문.',
          text: 'Original text. 원문.',
          fontSize: 12,
          confidence: 'high',
        },
      ],
    },
    overrides: { 'p1-b1': { text: 'Edited text. 보정.', order: 0, excluded: false } },
    savedAt: '2026-10-29T00:00:00.000Z',
  };
}

describe('project import boundary', () => {
  it('round-trips Unicode text, source identity, layout settings and manual corrections', () => {
    const original = project();
    expect(parseProject(JSON.stringify(original))).toEqual(original);
  });

  it.each([null, [], { schemaVersion: 0 }, { schemaVersion: 2 }])(
    'rejects unsupported project envelopes: %j',
    (value) => {
      expect(() => parseProject(JSON.stringify(value))).toThrow(/버전/);
    },
  );

  it('rejects a different reading-document source hash', () => {
    const value = project();
    value.reading.sourceHash = 'b'.repeat(64);
    expect(() => parseProject(JSON.stringify(value))).toThrow(/해시/);
  });

  it('rejects ambiguous duplicate block IDs before applying overrides', () => {
    const value = project();
    value.reading.blocks.push({ ...value.reading.blocks[0] });
    expect(() => parseProject(JSON.stringify(value))).toThrow(/중복 블록/);
  });

  it.each([{ x: -1 }, { y: -0.1 }, { width: 0 }, { height: 0 }, { width: 100_001 }])(
    'rejects invalid imported source rectangles: %j',
    (patch) => {
      const value = project();
      Object.assign(value.reading.blocks[0].rect, patch);
      expect(() => parseProject(JSON.stringify(value))).toThrow(/구조/);
    },
  );

  it('rejects non-finite geometry even when JSON numbers overflow JavaScript', () => {
    const value = JSON.stringify(project()).replace('"x":12', '"x":1e309');
    expect(() => parseProject(value)).toThrow(/구조/);
  });

  it.each([
    { pageWidthPt: 0 },
    { marginLeftPt: 500 },
    { fontSizePt: -1 },
    { lineHeightPt: 0 },
    { fontFamily: 'unknown' },
    { theme: 'unknown' },
  ])('applies the same layout validation to imported configuration: %j', (patch) => {
    const value = project();
    Object.assign(value.config, patch);
    expect(() => parseProject(JSON.stringify(value))).toThrow(RangeError);
  });

  it('rejects non-finite imported layout dimensions', () => {
    const value = JSON.stringify(project()).replace('"pageWidthPt":492', '"pageWidthPt":1e309');
    expect(() => parseProject(value)).toThrow(RangeError);
  });

  it('rejects overrides referring to an unknown source block', () => {
    const value = project();
    value.overrides.missing = { excluded: true };
    expect(() => parseProject(JSON.stringify(value))).toThrow(/보정/);
  });

  it.each([{ kind: 'javascript' }, { excluded: 'yes' }, { order: 'first' }, { text: [] }])(
    'rejects malformed correction data: %j',
    (patch) => {
      const value = project();
      Object.assign(value.overrides['p1-b1'], patch);
      expect(() => parseProject(JSON.stringify(value))).toThrow(/보정/);
    },
  );

  it('rejects oversized embedded text before it enters the editor or typesetter', () => {
    const value = project();
    value.reading.blocks[0].text = 'x'.repeat(2_000_001);
    expect(() => parseProject(JSON.stringify(value))).toThrow(/구조/);
  });

  it('rejects oversized correction text while preserving the valid original block', () => {
    const value = project();
    value.overrides['p1-b1'].text = 'x'.repeat(2_000_001);
    expect(() => parseProject(JSON.stringify(value))).toThrow(/보정/);
  });
});
