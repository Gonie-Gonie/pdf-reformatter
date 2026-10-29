import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DEMO_MANIFEST, generateDemoPdf } from '../src/adapters/pdf/demo.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = path.join(root, '.cache', 'fixtures');
await mkdir(fixtureDir, { recursive: true });
const bytes = await generateDemoPdf(
  async (name) => new Uint8Array(await readFile(path.join(root, 'public', 'fonts', name))),
);
await writeFile(path.join(fixtureDir, 'mixed-document.pdf'), bytes);
console.log(`Generated synthetic fixture: ${DEMO_MANIFEST.pages} pages, ${bytes.length} bytes.`);
