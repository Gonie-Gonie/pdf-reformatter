import type { LayoutConfig } from './model';
import { COLOR_THEMES } from './color-themes';

// Main screen: 203.1 mm diagonal, 1968 × 2184 pixels in portrait orientation.
// https://www.samsung.com/sec/smartphones/galaxy-z-fold7/specs/
const FOLD7_PT_PER_PIXEL = ((203.1 / 25.4) * 72) / Math.hypot(1968, 2184);

export const DEFAULT_CONFIG: LayoutConfig = {
  pageWidthPt: 1968 * FOLD7_PT_PER_PIXEL,
  pageHeightPt: 2184 * FOLD7_PT_PER_PIXEL,
  marginTopPt: 34,
  marginBottomPt: 34,
  marginLeftPt: 34,
  marginRightPt: 34,
  fontSizePt: 13.2,
  lineHeightPt: 21.1,
  paragraphGapPt: 8,
  fontFamily: 'serif',
  theme: 'warm',
};

export const PRESETS = [
  {
    name: '갤럭시 Z 폴드7',
    shape: 'fold',
    width: DEFAULT_CONFIG.pageWidthPt,
    height: DEFAULT_CONFIG.pageHeightPt,
  },
  {
    name: 'iPhone Duo',
    shape: 'iphone-duo',
    // Approximate active inner screen, in the device's unfolded landscape orientation.
    // https://www.apple.com/kr/iphone-duo/specs/ — 2670 × 1878 pixels at 430 PPI.
    width: (2670 / 430) * 72,
    height: (1878 / 430) * 72,
  },
  {
    name: '몽블랑 디지털 페이퍼',
    shape: 'paper',
    // Approximate active screen size from 1860 × 2480 pixels at the specified 300 PPI.
    width: (1860 / 300) * 72,
    height: (2480 / 300) * 72,
  },
] as const;

const labels: Record<keyof Omit<LayoutConfig, 'fontFamily' | 'theme'>, string> = {
  pageWidthPt: '페이지 가로',
  pageHeightPt: '페이지 세로',
  marginTopPt: '위 여백',
  marginBottomPt: '아래 여백',
  marginLeftPt: '왼쪽 여백',
  marginRightPt: '오른쪽 여백',
  fontSizePt: '글자 크기',
  lineHeightPt: '행간',
  paragraphGapPt: '문단 간격',
};

/** The same boundary validates form edits and imported project configuration. */
export function validateConfig(value: unknown): LayoutConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RangeError('설정은 JSON 객체여야 합니다.');
  }
  const input = value as Record<string, unknown>;
  for (const [key, label] of Object.entries(labels)) {
    const number = input[key];
    if (typeof number !== 'number' || !Number.isFinite(number)) {
      throw new RangeError(`${label}에 유한한 숫자를 입력하세요.`);
    }
    if (number < 0) throw new RangeError(`${label}은 음수가 될 수 없습니다.`);
  }
  if (input.fontFamily !== 'serif' && input.fontFamily !== 'sans') {
    throw new RangeError('지원하지 않는 글꼴 설정입니다.');
  }
  if (!COLOR_THEMES.some((theme) => theme.id === input.theme)) {
    throw new RangeError('지원하지 않는 색상 설정입니다.');
  }
  const config = { ...input } as unknown as LayoutConfig;
  if (
    config.pageWidthPt < 72 ||
    config.pageWidthPt > 2400 ||
    config.pageHeightPt < 72 ||
    config.pageHeightPt > 2400
  ) {
    throw new RangeError('페이지 가로와 세로는 72~2400 pt 범위로 입력하세요.');
  }
  if (config.fontSizePt < 6 || config.fontSizePt > 72) {
    throw new RangeError('글자 크기는 6~72 pt 범위로 입력하세요.');
  }
  if (config.lineHeightPt < config.fontSizePt * 1.05 || config.lineHeightPt > 180) {
    throw new RangeError('행간은 글자 크기의 1.05배 이상, 180 pt 이하로 입력하세요.');
  }
  if (config.paragraphGapPt > 240) throw new RangeError('문단 간격은 240 pt 이하여야 합니다.');
  const width = config.pageWidthPt - config.marginLeftPt - config.marginRightPt;
  const height = config.pageHeightPt - config.marginTopPt - config.marginBottomPt;
  if (width < config.fontSizePt * 2 || height < config.lineHeightPt * 2 + 16) {
    throw new RangeError(
      '여백을 줄이거나 페이지를 키워 본문 두 글자와 두 줄 이상을 배치할 공간을 확보하세요.',
    );
  }
  return {
    pageWidthPt: config.pageWidthPt,
    pageHeightPt: config.pageHeightPt,
    marginTopPt: config.marginTopPt,
    marginBottomPt: config.marginBottomPt,
    marginLeftPt: config.marginLeftPt,
    marginRightPt: config.marginRightPt,
    fontSizePt: config.fontSizePt,
    lineHeightPt: config.lineHeightPt,
    paragraphGapPt: config.paragraphGapPt,
    fontFamily: config.fontFamily,
    theme: config.theme,
  };
}
