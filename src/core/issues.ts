import type {
  CriticalIssue,
  LayoutDocument,
  Overrides,
  ReadingDocument,
  SourceDocument,
} from './model';

/** Only content-loss risks belong in review; routine visual changes do not. */
export function collectCriticalIssues(
  source: SourceDocument,
  reading: ReadingDocument,
  overrides: Overrides,
  layout: LayoutDocument,
): CriticalIssue[] {
  const selectedPages = new Set(source.pages.map((page) => page.number));
  const issues: CriticalIssue[] = source.pages
    .filter((page) => selectedPages.has(page.number))
    .flatMap((page) => page.issues ?? []);
  const sourceOwners = new Map<string, string[]>();
  const placed = new Set(
    layout.pages.flatMap((page) => page.placements.map((item) => item.blockId)),
  );
  for (const block of reading.blocks) {
    if (!selectedPages.has(block.sourcePage)) continue;
    if (overrides[block.id]?.excluded) {
      issues.push({
        id: `excluded:${block.id}`,
        code: 'missing-content',
        sourcePage: block.sourcePage,
        blockId: block.id,
        rect: block.rect,
        message: '이 영역이 결과에서 제외됩니다.',
      });
      continue;
    }
    for (const id of block.sourceIds)
      sourceOwners.set(id, [...(sourceOwners.get(id) ?? []), block.id]);
    const preserved = block.kind === 'sourceRegion' || overrides[block.id]?.kind === 'sourceRegion';
    if (!preserved && /[\u0000\ufffd]/u.test(overrides[block.id]?.text ?? block.text)) {
      issues.push({
        id: `text:${block.id}`,
        code: 'unreadable-text',
        sourcePage: block.sourcePage,
        blockId: block.id,
        rect: block.rect,
        message: '일부 문자를 읽지 못해 내용이 달라질 수 있습니다.',
      });
    }
    if (!placed.has(block.id) && (block.text.trim() || preserved)) {
      issues.push({
        id: `unplaced:${block.id}`,
        code: 'unplaced-content',
        sourcePage: block.sourcePage,
        blockId: block.id,
        rect: block.rect,
        message: '이 영역을 결과에 배치하지 못했습니다.',
      });
    }
  }
  for (const page of source.pages) {
    if (!selectedPages.has(page.number)) continue;
    const missing = page.items.filter((item) => !sourceOwners.has(item.id));
    if (
      missing.length &&
      !reading.blocks.some(
        (block) => block.sourcePage === page.number && overrides[block.id]?.excluded,
      )
    ) {
      issues.push({
        id: `missing:${page.number}`,
        code: 'missing-content',
        sourcePage: page.number,
        message: '원문의 일부 내용을 결과에서 찾지 못했습니다.',
      });
    }
    const duplicate = page.items.find((item) => (sourceOwners.get(item.id)?.length ?? 0) > 1);
    if (duplicate)
      issues.push({
        id: `duplicate:${page.number}`,
        code: 'duplicate-content',
        sourcePage: page.number,
        message: '일부 내용이 중복될 수 있습니다.',
      });
  }
  return [...new Map(issues.map((issue) => [issue.id, issue])).values()];
}
