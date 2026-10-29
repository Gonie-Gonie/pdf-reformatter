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
  reason?: string;
  confidence: 'high' | 'review';
  semantic?: 'toc' | 'index' | 'note';
  noteLabel?: string;
  sourceSpans?: SourceSpan[];
  anchor?: BlockAnchor;
  keepTogether?: boolean;
  running?: 'header' | 'footer';
  runningPageNumber?: boolean;
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
  theme: 'warm' | 'light';
}
export type Decoration = 'lineNumber' | 'runningHeader' | 'runningFooter';
export interface TextPlacement extends Rect {
  type: 'text';
  blockId: string;
  sourcePage: number;
  text: string;
  fontSize: number;
  textStart?: number;
  textEnd?: number;
  decoration?: Decoration;
}
export interface RegionPlacement extends Rect {
  type: 'region';
  blockId: string;
  sourcePage: number;
  sourceRect: Rect;
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
