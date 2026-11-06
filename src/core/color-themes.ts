export const COLOR_THEMES = [
  { id: 'warm', background: '#f6f0e3', foreground: '#41342b', label: '아이보리 배경 · 갈색 글자' },
  { id: 'light', background: '#ffffff', foreground: '#1f2124', label: '흰 배경 · 검은 글자' },
  {
    id: 'sepia',
    background: '#e9dcc3',
    foreground: '#433526',
    label: '베이지 배경 · 짙은 갈색 글자',
  },
  {
    id: 'gray',
    background: '#e7e9ed',
    foreground: '#20252c',
    label: '연회색 배경 · 짙은 회색 글자',
  },
  {
    id: 'sage',
    background: '#e8efe5',
    foreground: '#283e2b',
    label: '연녹색 배경 · 짙은 녹색 글자',
  },
  {
    id: 'mint',
    background: '#e6f2ee',
    foreground: '#234239',
    label: '민트색 배경 · 짙은 청록색 글자',
  },
  {
    id: 'blue',
    background: '#e9f0f8',
    foreground: '#233b54',
    label: '연파랑 배경 · 짙은 파랑 글자',
  },
  {
    id: 'lavender',
    background: '#eeeaf6',
    foreground: '#38304f',
    label: '연보라 배경 · 짙은 보라 글자',
  },
  {
    id: 'rose',
    background: '#f6e9e8',
    foreground: '#56343b',
    label: '연분홍 배경 · 짙은 자주색 글자',
  },
  {
    id: 'charcoal',
    background: '#22262c',
    foreground: '#e9e6df',
    label: '짙은 회색 배경 · 밝은 회색 글자',
  },
  { id: 'navy', background: '#162535', foreground: '#e4ebf3', label: '남색 배경 · 밝은 파랑 글자' },
  {
    id: 'black',
    background: '#101010',
    foreground: '#e6e6e6',
    label: '검은 배경 · 밝은 회색 글자',
  },
] as const;

export type ColorTheme = (typeof COLOR_THEMES)[number]['id'];

export function colorTheme(id: ColorTheme): (typeof COLOR_THEMES)[number] {
  return COLOR_THEMES.find((theme) => theme.id === id) ?? COLOR_THEMES[0];
}
