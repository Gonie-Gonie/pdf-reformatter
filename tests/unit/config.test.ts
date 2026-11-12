import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, validateConfig } from '../../src/core/config';

describe('automatic rotation configuration', () => {
  it('enables automatic rotation by default and preserves an explicit opt-out', () => {
    expect(DEFAULT_CONFIG.autoRotateFigures).toBe(true);
    expect(validateConfig(DEFAULT_CONFIG).autoRotateFigures).toBe(true);
    expect(validateConfig({ ...DEFAULT_CONFIG, autoRotateFigures: false }).autoRotateFigures).toBe(
      false,
    );
  });

  it.each([undefined, null, 'true', 'false', 0, 1, {}])(
    'rejects a non-boolean rotation setting %j',
    (value) => {
      expect(() => validateConfig({ ...DEFAULT_CONFIG, autoRotateFigures: value })).toThrow(
        '자동 회전 설정',
      );
    },
  );
});

describe('bionic reading configuration', () => {
  it('starts disabled and preserves an explicit opt-in', () => {
    expect(DEFAULT_CONFIG.bionicReading).toBe(false);
    expect(validateConfig(DEFAULT_CONFIG).bionicReading).toBe(false);
    expect(validateConfig({ ...DEFAULT_CONFIG, bionicReading: true }).bionicReading).toBe(true);
  });

  it.each([undefined, null, 'true', 'false', 0, 1, {}])(
    'rejects a non-boolean bionic reading setting %j',
    (value) => {
      expect(() => validateConfig({ ...DEFAULT_CONFIG, bionicReading: value })).toThrow(
        '바이오닉 리딩 설정',
      );
    },
  );
});
