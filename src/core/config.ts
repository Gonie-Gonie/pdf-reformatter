import type { LayoutConfig } from './model';

export const DEFAULT_CONFIG: LayoutConfig = {
  pageWidthPt: 492,
  pageHeightPt: 546,
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
    id: 'fold7-main-approved',
    name: 'Fold7 펼친 화면',
    description: '492 × 546 pt · 본문 13.2 pt · 행간 21.1 pt',
    config: { ...DEFAULT_CONFIG },
  },
  {
    id: 'phone',
    name: '휴대폰 세로',
    description: '360 × 640 pt · 작은 화면에 맞춘 읽기본',
    config: {
      ...DEFAULT_CONFIG,
      pageWidthPt: 360,
      pageHeightPt: 640,
      marginLeftPt: 24,
      marginRightPt: 24,
    },
  },
  {
    id: 'a5',
    name: 'A5 읽기본',
    description: '419.53 × 595.28 pt · 인쇄와 태블릿',
    config: { ...DEFAULT_CONFIG, pageWidthPt: 419.53, pageHeightPt: 595.28 },
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
  if (input.theme !== 'warm' && input.theme !== 'light') {
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
