import { PDFDocument, rgb } from 'pdf-lib';
import type { PDFFont, PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

/** Original synthetic content, created for this project; no third-party source PDF. */
export const FIXTURE_MANIFEST = {
  schemaVersion: 1,
  title: 'PDF Reflow Lab - synthetic mixed document',
  pages: 3,
  license: 'CC0-1.0 (original synthetic text and drawings; embedded fonts retain SIL OFL)',
  expected: {
    reflowedText: true,
    preservedRegions: true,
    sourceItemsOwnedOnce: true,
    readingOrderPage2: ['Left column begins here.', 'Right column begins here.'],
    textMarkers: [
      'A quieter way to read',
      'Left column begins here.',
      'Right column begins here.',
      '한글 문단의 줄바꿈',
      '원문 표의 모양을 보존합니다',
    ],
  },
  features: [
    'English paragraphs',
    'Korean paragraphs',
    'two columns',
    'display math',
    'vector bar chart',
    'vector table',
    'captions',
    'footnote',
    'reference',
  ],
};

const ink = rgb(0.17, 0.2, 0.23);
const muted = rgb(0.39, 0.43, 0.46);
const accent = rgb(0.15, 0.43, 0.37);

function wrapped(
  page: PDFPage,
  text: string,
  font: PDFFont,
  x: number,
  y: number,
  width: number,
  size = 11,
  leading = 16,
): number {
  const tokens = text.match(/\S+\s*|\s+/gu) ?? [];
  let line = '';
  const draw = () => {
    if (line.trim()) page.drawText(line.trimEnd(), { x, y, font, size, color: ink });
    y -= leading;
    line = '';
  };
  for (const token of tokens) {
    if (font.widthOfTextAtSize(line + token.trimEnd(), size) <= width) {
      line += token;
      continue;
    }
    if (font.widthOfTextAtSize(token.trimEnd(), size) <= width) {
      draw();
      line = token.trimStart();
      continue;
    }
    for (const char of token) {
      if (font.widthOfTextAtSize(line + char, size) > width) draw();
      line += char;
    }
  }
  if (line.trim()) draw();
  return y;
}

function rule(page: PDFPage, y: number) {
  page.drawLine({
    start: { x: 48, y },
    end: { x: 564, y },
    thickness: 0.6,
    color: rgb(0.77, 0.8, 0.79),
  });
}

export async function generateMixedDocumentPdf(
  loadFont: (name: string) => Promise<Uint8Array>,
): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.registerFontkit(fontkit);
  const [regularBytes, boldBytes, cjkBytes] = await Promise.all([
    loadFont('NotoSerif-Regular.ttf'),
    loadFont('NotoSerif-Bold.ttf'),
    loadFont('NotoSansKR-Regular.ttf'),
  ]);
  const regular = await document.embedFont(regularBytes, { subset: true });
  const bold = await document.embedFont(boldBytes, { subset: true });
  const korean = await document.embedFont(cjkBytes, { subset: true });
  document.setTitle(FIXTURE_MANIFEST.title);
  document.setAuthor('PDF Reflow contributors');
  document.setCreator('pdf-reformatter synthetic fixture generator');
  document.setCreationDate(new Date('2026-10-29T00:00:00.000Z'));
  document.setModificationDate(new Date('2026-10-29T00:00:00.000Z'));
  document.setSubject('Original CC0 synthetic document for local PDF reflow tests');

  const one = document.addPage([612, 792]);
  one.drawText('PDF REFLOW LAB / SYNTHETIC DOCUMENT', {
    x: 48,
    y: 748,
    font: regular,
    size: 8,
    color: muted,
  });
  one.drawText('A quieter way to read', { x: 48, y: 705, font: bold, size: 23, color: ink });
  one.drawText('01  /  Paragraphs and an original vector figure', {
    x: 48,
    y: 679,
    font: regular,
    size: 10,
    color: accent,
  });
  let y = 640;
  y = wrapped(
    one,
    'This document was written specifically for testing PDF reflow. Its words, chart and table are synthetic. A reader should be able to choose a smaller page without losing sentences, inventing content or changing the order of a paragraph.',
    regular,
    48,
    y,
    516,
  );
  y = wrapped(
    one,
    'Ordinary body text belongs in a flowing column. The original line endings are part of a page design, so the reading edition joins those lines into paragraphs and measures each new line with the font that is embedded in the output.',
    regular,
    48,
    y - 14,
    516,
  );
  y = wrapped(
    one,
    'A drawing carries relationships that plain text cannot express. Labels, bars and axes below share one visual region. The converter should preserve that region while allowing the surrounding prose to move to a new page.',
    regular,
    48,
    y - 14,
    516,
  );
  const chart = { x: 80, y: 220, width: 452, height: 170 };
  one.drawRectangle({
    ...chart,
    color: rgb(0.96, 0.98, 0.97),
    borderColor: rgb(0.55, 0.67, 0.63),
    borderWidth: 0.8,
  });
  const baseline = chart.y + 30;
  one.drawLine({
    start: { x: 120, y: baseline },
    end: { x: 503, y: baseline },
    thickness: 1,
    color: muted,
  });
  one.drawLine({
    start: { x: 120, y: baseline },
    end: { x: 120, y: 367 },
    thickness: 1,
    color: muted,
  });
  const bars = [61, 94, 78, 113];
  const labels = ['Text', 'Math', 'Figure', 'Table'];
  for (let index = 0; index < bars.length; index++) {
    const x = 150 + index * 84;
    one.drawRectangle({
      x,
      y: baseline,
      width: 38,
      height: bars[index],
      color: index % 2 ? rgb(0.62, 0.74, 0.66) : accent,
    });
    one.drawText(labels[index], { x: x - 1, y: baseline - 18, size: 9, font: regular, color: ink });
    one.drawText(String(bars[index]), {
      x: x + 11,
      y: baseline + bars[index] + 7,
      size: 9,
      font: regular,
      color: ink,
    });
  }
  one.drawText('Figure 1. Synthetic bars; the values are arbitrary test data.', {
    x: 80,
    y: 200,
    size: 10,
    font: regular,
    color: ink,
  });
  wrapped(
    one,
    'The reading edition contains the selected source content in a new page format. Its paragraphs and preserved drawings retain their original order. A change of page size must keep the final sentence and the footnote below.',
    regular,
    48,
    164,
    516,
  );
  rule(one, 64);
  one.drawText('1. A small footnote remains part of the source and must not disappear.', {
    x: 48,
    y: 48,
    size: 8,
    font: regular,
    color: muted,
  });
  one.drawText('1', { x: 555, y: 24, size: 8, font: regular, color: muted });

  const two = document.addPage([612, 792]);
  two.drawText('Reading order across two columns', {
    x: 48,
    y: 724,
    font: bold,
    size: 20,
    color: ink,
  });
  two.drawText('02  /  Left column, then right column, then the equation', {
    x: 48,
    y: 697,
    font: regular,
    size: 10,
    color: accent,
  });
  const left = [
    'Left column begins here. A two-column page saves paper, but it can be awkward on a small screen. Reading order should follow this entire left column before continuing at the top of the right column.',
    'This paragraph introduces a simple conservation rule: each source text item must have exactly one owner. An item may belong to reflowed prose or to a preserved drawing. Both paths retain the source content.',
    'Line-end hyphens are not silently removed. A word that is uncertain remains as extracted. The same words must remain in reading order after layout changes.',
  ];
  const right = [
    'Right column begins here. This sentence follows the last sentence of the left column. A geometry-based detector can identify a stable gutter, but the final order still deserves human inspection.',
    'The expression below contains mathematical symbols and a fraction rule. Preserving its original appearance avoids a false reconstruction of subscripts, superscripts or operators. It should have no duplicate prose copy.',
    'A change in font size recomputes line breaks and page breaks. The output should remain within the usable margins. A large indivisible object moves to a fresh page before being scaled down to fit.',
  ];
  y = 658;
  for (const paragraph of left) y = wrapped(two, paragraph, regular, 48, y, 243, 10.5, 15.5) - 15;
  y = 658;
  for (const paragraph of right) y = wrapped(two, paragraph, regular, 321, y, 243, 10.5, 15.5) - 15;
  two.drawText('E = mc²       x ≤ y       ∑ x = 10', {
    x: 145,
    y: 220,
    size: 16,
    font: korean,
    color: ink,
  });
  two.drawRectangle({
    x: 220,
    y: 145,
    width: 340,
    height: 55,
    borderColor: rgb(0.76, 0.81, 0.78),
    borderWidth: 0.5,
  });
  two.drawText('a + b', { x: 257, y: 183, size: 14, font: regular, color: ink });
  two.drawLine({ start: { x: 248, y: 178 }, end: { x: 303, y: 178 }, thickness: 0.8, color: ink });
  two.drawText('c + d', { x: 257, y: 158, size: 14, font: regular, color: ink });
  two.drawText('(1)', { x: 525, y: 178, size: 11, font: regular, color: ink });
  two.drawText('Equation 1. Original symbols and fraction geometry are test content.', {
    x: 80,
    y: 125,
    size: 10,
    font: regular,
    color: ink,
  });
  rule(two, 64);
  two.drawText(
    '[1] PDF Reflow contributors. Synthetic corpus, 2026. https://example.invalid/reflow',
    { x: 48, y: 48, size: 8, font: regular, color: muted },
  );
  two.drawText('2', { x: 555, y: 24, size: 8, font: regular, color: muted });

  const three = document.addPage([612, 792]);
  three.drawText('한글 문단의 줄바꿈', { x: 48, y: 724, font: korean, size: 22, color: ink });
  three.drawText('03  /  한글 본문과 원형을 유지하는 표', {
    x: 48,
    y: 695,
    font: korean,
    size: 11,
    color: accent,
  });
  y = 650;
  y = wrapped(
    three,
    '이 문서는 PDF 재조판을 시험하기 위해 직접 작성한 합성 자료입니다. 일반 문단은 설정한 화면 폭에 맞춰 다시 줄바꿈합니다. 한글 문자가 빠지거나 네모로 바뀌지 않도록 글꼴을 포함하고 실제 글자 폭으로 새 줄을 계산합니다.',
    korean,
    48,
    y,
    516,
    11,
    18,
  );
  y = wrapped(
    three,
    '그림과 표는 원문의 모양을 보존합니다. 표 안의 글자를 본문으로 한 번 더 넣으면 내용이 중복되므로 표 영역에 소유권을 부여합니다. 복잡한 읽기 순서나 불확실한 영역은 원문 대조 화면에서 확인할 수 있습니다.',
    korean,
    48,
    y - 16,
    516,
    11,
    18,
  );
  y = wrapped(
    three,
    '페이지 크기와 글자 크기를 바꾸면 줄바꿈과 페이지 나눔을 다시 계산합니다. 아래 표의 숫자는 아무 측정 결과도 나타내지 않는 임의의 시험 값입니다. 문단과 표의 배치가 달라져도 마지막 문장은 결과에 남아야 합니다.',
    korean,
    48,
    y - 16,
    516,
    11,
    18,
  );
  const tableX = 80,
    tableY = 242,
    rowHeight = 34,
    tableWidth = 452;
  const columns = [0, 165, 304, 452];
  three.drawRectangle({
    x: tableX,
    y: tableY,
    width: tableWidth,
    height: rowHeight * 4,
    color: rgb(0.98, 0.98, 0.96),
    borderColor: muted,
    borderWidth: 0.8,
  });
  three.drawRectangle({
    x: tableX,
    y: tableY + rowHeight * 3,
    width: tableWidth,
    height: rowHeight,
    color: rgb(0.88, 0.93, 0.89),
  });
  for (let row = 1; row < 4; row++)
    three.drawLine({
      start: { x: tableX, y: tableY + row * rowHeight },
      end: { x: tableX + tableWidth, y: tableY + row * rowHeight },
      thickness: 0.7,
      color: muted,
    });
  for (const offset of columns.slice(1, -1))
    three.drawLine({
      start: { x: tableX + offset, y: tableY },
      end: { x: tableX + offset, y: tableY + rowHeight * 4 },
      thickness: 0.7,
      color: muted,
    });
  const rows = [
    ['항목', '시험 값', '처리 방법'],
    ['일반 문단', '42', '다시 줄바꿈'],
    ['그림·표', '17', '원문 영역 보존'],
    ['수식', '8', '원문 모양 유지'],
  ];
  for (let row = 0; row < rows.length; row++)
    for (let column = 0; column < rows[row].length; column++) {
      three.drawText(rows[row][column], {
        x: tableX + columns[column] + 12,
        y: tableY + rowHeight * (3 - row) + 12,
        size: 10,
        font: korean,
        color: ink,
      });
    }
  three.drawText('표 1. 원문 표의 모양을 보존합니다. 숫자는 임의의 시험 값입니다.', {
    x: 80,
    y: 220,
    size: 10,
    font: korean,
    color: ink,
  });
  wrapped(
    three,
    '표 아래에 이어지는 마지막 문단입니다. 표를 이미지로 보존하더라도 주변 본문은 순서대로 이어집니다. 이 문단의 끝과 아래쪽 작은 글씨도 새 페이지 크기에 맞춘 결과에서 확인할 수 있어야 합니다.',
    korean,
    48,
    180,
    516,
    11,
    18,
  );
  rule(three, 64);
  three.drawText('합성 시험 자료 · 개인 문서나 외부 논문을 포함하지 않습니다.', {
    x: 48,
    y: 45,
    size: 8,
    font: korean,
    color: muted,
  });
  three.drawText('3', { x: 555, y: 24, size: 8, font: regular, color: muted });
  return document.save();
}
