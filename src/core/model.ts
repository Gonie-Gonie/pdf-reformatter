import type { ColorTheme } from './color-themes';

/** All geometry is in PDF points, in the visible page's top-left coordinate system. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export type TextAlignment = 'left' | 'right' | 'center' | 'justify';
export interface TextSpacing {
  /** UTF-16 offset after the complete grapheme or space receiving extra advance. */
  after: number;
  extra: number;
}
export interface SourceText extends Rect {
  id: string;
  text: string;
  fontSize: number;
  fontName: string;
  hasEOL: boolean;
  baselineY?: number;
  spaceBefore?: boolean;
  alignment?: TextAlignment;
  markedContentId?: string;
  structureRoles?: string[];
  artifact?: boolean;
  rotation?: number;
  preserve?: boolean;
}
export interface SourceStructure {
  id: string;
  role: string;
  sourceIds: string[];
  order: number;
  parentId?: string;
}
export interface SourcePage {
  number: number;
  width: number;
  height: number;
  rotation: number;
  items: SourceText[];
  graphicRegions: Rect[];
  warnings: string[];
  issues?: CriticalIssue[];
  structure?: SourceStructure[];
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
  | 'heading'
  | 'paragraph'
  | 'list'
  | 'caption'
  | 'footnote'
  | 'reference'
  | 'sourceRegion'
  | 'lineNumber';
/** Character offsets use NFKC text with whitespace and soft hyphens removed. */
export interface SourceSpan {
  sourceId: string;
  start: number;
  end: number;
  rect: Rect;
}
export interface BlockAnchor {
  blockId: string;
  sourceId?: string;
  offset?: number;
}
export interface InlineMathSpan {
  /** UTF-16 offsets in the containing block's unchanged text. */
  start: number;
  end: number;
  sourceIds: string[];
  rect: Rect;
  baselineY: number;
  fontSize: number;
}
export interface ReadingReference {
  id: string;
  source: BlockAnchor;
  targetBlockId: string;
}
export interface ReadingBlock {
  id: string;
  kind: BlockKind;
  sourcePage: number;
  sourceIds: string[];
  rect: Rect;
  rawText: string;
  text: string;
  fontSize: number;
  alignment?: TextAlignment;
  inlineMath?: InlineMathSpan[];
  reason?: string;
  confidence: 'high' | 'review';
  semantic?: 'toc' | 'index' | 'note' | 'table';
  noteLabel?: string;
  sourceSpans?: SourceSpan[];
  anchor?: BlockAnchor;
  keepTogether?: boolean;
  running?: 'header' | 'footer';
  runningPageNumber?: boolean;
  startOnNewPage?: boolean;
}
export interface ReadingDocument {
  schemaVersion: 1;
  sourceHash: string;
  blocks: ReadingBlock[];
  warnings: string[];
  references?: ReadingReference[];
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
  theme: ColorTheme;
}
export type Decoration = 'lineNumber' | 'runningHeader' | 'runningFooter';
export interface TextPlacement extends Rect {
  type: 'text';
  blockId: string;
  sourcePage: number;
  text: string;
  fontSize: number;
  spacing?: TextSpacing[];
  textStart?: number;
  textEnd?: number;
  decoration?: Decoration;
}
export interface RegionPlacement extends Rect {
  type: 'region';
  blockId: string;
  sourcePage: number;
  sourceRect: Rect;
  /** Source character range for a mathematical object inside a flowing paragraph. */
  textStart?: number;
  textEnd?: number;
  math?: boolean;
  decoration?: Decoration;
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
export interface CriticalIssue {
  id: string;
  code:
    | 'missing-content'
    | 'duplicate-content'
    | 'unreadable-text'
    | 'unplaced-content'
    | 'unsupported-annotation';
  sourcePage: number;
  message: string;
  blockId?: string;
  rect?: Rect;
}
export interface ConversionResult {
  readingPdf: Uint8Array;
  readingEpub?: Uint8Array;
  layout: LayoutDocument;
  scope: 'full' | 'preview';
  selectedPages: number[];
  source: SourceDocument;
  reading: ReadingDocument;
  issues: CriticalIssue[];
}
export interface Progress {
  stage: string;
  current: number;
  total: number;
  message: string;
}
