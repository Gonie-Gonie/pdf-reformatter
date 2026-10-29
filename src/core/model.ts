/** All geometry is in PDF points, in the visible page's top-left coordinate system. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface SourceText extends Rect {
  id: string;
  text: string;
  fontSize: number;
  fontName: string;
  hasEOL: boolean;
}
export interface SourcePage {
  number: number;
  width: number;
  height: number;
  rotation: number;
  items: SourceText[];
  graphicRegions: Rect[];
  warnings: string[];
}
export interface SourceDocument {
  schemaVersion: 1;
  hash: string;
  name: string;
  pageCount: number;
  pages: SourcePage[];
  engine: string;
}
export type BlockKind =
  'heading' | 'paragraph' | 'list' | 'caption' | 'footnote' | 'reference' | 'sourceRegion';
export interface ReadingBlock {
  id: string;
  kind: BlockKind;
  sourcePage: number;
  sourceIds: string[];
  rect: Rect;
  rawText: string;
  text: string;
  fontSize: number;
  reason?: string;
  confidence: 'high' | 'review';
}
export interface ReadingDocument {
  schemaVersion: 1;
  sourceHash: string;
  blocks: ReadingBlock[];
  warnings: string[];
}
export interface BlockOverride {
  kind?: BlockKind;
  text?: string;
  excluded?: boolean;
  order?: number;
}
export type Overrides = Record<string, BlockOverride>;
export interface LayoutConfig {
  pageWidthPt: number;
  pageHeightPt: number;
  marginTopPt: number;
  marginBottomPt: number;
  marginLeftPt: number;
  marginRightPt: number;
  fontSizePt: number;
  lineHeightPt: number;
  paragraphGapPt: number;
  fontFamily: 'serif' | 'sans';
  theme: 'warm' | 'light';
}
export interface TextPlacement extends Rect {
  type: 'text';
  blockId: string;
  sourcePage: number;
  text: string;
  fontSize: number;
}
export interface RegionPlacement extends Rect {
  type: 'region';
  blockId: string;
  sourcePage: number;
  sourceRect: Rect;
}
export type Placement = TextPlacement | RegionPlacement;
export interface LayoutPage {
  number: number;
  placements: Placement[];
  sourcePages: number[];
}
export interface LayoutDocument {
  pages: LayoutPage[];
  config: LayoutConfig;
  warnings: string[];
}
export interface VerificationReport {
  schemaVersion: 1;
  appVersion: string;
  createdAt: string;
  sourceHash: string;
  sourceName: string;
  sourcePages: number;
  outputPages: number;
  scope: 'full' | 'preview';
  selectedPages: number[];
  config: LayoutConfig;
  blockCount: number;
  reflowedBlocks: number;
  preservedBlocks: number;
  excludedBlocks: number;
  warnings: string[];
  checks: { name: string; passed: boolean; detail: string }[];
  blocks: {
    id: string;
    sourcePage: number;
    kind: BlockKind;
    route: string;
    outputPages: number[];
    reason?: string;
  }[];
  limitations: string[];
}
export interface ConversionResult {
  readingPdf: Uint8Array;
  comparisonPdf: Uint8Array;
  report: VerificationReport;
  layout: LayoutDocument;
}
export interface Progress {
  stage: string;
  current: number;
  total: number;
  message: string;
}
export interface SavedProject {
  schemaVersion: 1;
  sourceHash: string;
  sourceName: string;
  config: LayoutConfig;
  overrides: Overrides;
  reading: ReadingDocument;
  savedAt: string;
}
