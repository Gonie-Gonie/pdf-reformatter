import type { ReadingBlock, SourcePage } from './model';

interface RotationFit {
  rotation: 90 | 270;
  scale: number;
}

function uprightTurn(block: ReadingBlock, page?: SourcePage): 90 | 270 {
  const ids = new Set(block.sourceIds);
  let characters = 0;
  let clockwise = 0;
  for (const item of page?.items ?? []) {
    if (!ids.has(item.id)) continue;
    const weight = item.text.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
    characters += weight;
    const angle = (((item.rotation ?? 0) % 360) + 360) % 360;
    if (Math.abs(angle - 90) < 10) clockwise += weight;
  }
  return characters > 0 && clockwise / characters >= 0.6 ? 270 : 90;
}

/** Compare complete page boxes, so preceding prose never changes the decision. */
export function fitRotatedRegion(
  block: ReadingBlock,
  width: number,
  height: number,
  captionReserve = 0,
  page?: SourcePage,
): RotationFit | undefined {
  const reason = block.reason ?? '';
  if (
    block.kind !== 'sourceRegion' ||
    block.running ||
    (block.semantic && block.semantic !== 'table') ||
    (block.semantic !== 'table' && !/그림|표/u.test(reason)) ||
    /수식|코드|목차|색인|본문|문단|전체|페이지/u.test(reason)
  )
    return undefined;

  const { width: sourceWidth, height: sourceHeight } = block.rect;
  // Ignore icons, narrow rules and full-page preservation fallbacks.
  if (
    Math.max(sourceWidth, sourceHeight) < 144 ||
    Math.min(sourceWidth, sourceHeight) < 60 ||
    (page && sourceWidth * sourceHeight >= page.width * page.height * 0.85)
  )
    return undefined;
  const normalScale = Math.min(1, width / sourceWidth, height / sourceHeight);
  const scale = Math.min(1, width / sourceHeight, (height - captionReserve) / sourceWidth);
  const normalArea = sourceWidth * sourceHeight * normalScale ** 2;
  const rotatedArea = sourceWidth * sourceHeight * scale ** 2;
  const pageArea = width * height;
  if (
    !Number.isFinite(scale) ||
    scale <= 0 ||
    normalArea < pageArea * 0.1 ||
    rotatedArea < pageArea * 0.25 ||
    rotatedArea + 0.001 < normalArea * 2 ||
    Math.min(sourceWidth, sourceHeight) * scale < 48
  )
    return undefined;
  return { rotation: uprightTurn(block, page), scale };
}
