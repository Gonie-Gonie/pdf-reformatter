import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fontkit from '@pdf-lib/fontkit';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const filenames = [
  'NotoSerif-Regular.ttf',
  'NotoSerif-Bold.ttf',
  'NotoSans-Regular.ttf',
  'NotoSansKR-Regular.ttf',
];
const fonts = [];
for (const filename of filenames) {
  const bytes = await readFile(join(root, 'public', 'fonts', filename));
  const font = fontkit.create(new Uint8Array(bytes));
  fonts.push({
    filename,
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    family: font.familyName,
    version: font.version,
    copyright: font.copyright,
    license: 'OFL-1.1',
    source: filename.includes('KR')
      ? 'https://github.com/google/fonts/tree/main/ofl/notosanskr'
      : `https://github.com/notofonts/noto-fonts/tree/main/hinted/ttf/${filename.startsWith('NotoSerif') ? 'NotoSerif' : 'NotoSans'}`,
    ...(filename.includes('KR')
      ? {
          derivation:
            'Static weight 400 instance of NotoSansKR[wght].ttf via fontTools 4.55.0; GSUB/GPOS/GDEF/BASE and vertical metrics removed; glyf padding 4 for fontkit subset compatibility. Glyph outlines retained; complex shaping unsupported.',
        }
      : {}),
  });
}
await writeFile(join(root, 'legal', 'fonts.json'), JSON.stringify(fonts, null, 2) + '\n');
console.log(`Recorded ${fonts.length} font versions and SHA-256 hashes`);
