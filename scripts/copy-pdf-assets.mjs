import { cp, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRoot = join(root, 'node_modules', 'pdfjs-dist');
const publicRoot = join(root, '.cache', 'public', 'pdfjs');
await mkdir(publicRoot, { recursive: true });
for (const directory of ['cmaps', 'standard_fonts', 'wasm']) {
  const source = join(packageRoot, directory);
  try {
    await stat(source);
  } catch (error) {
    if (directory === 'wasm' && error.code === 'ENOENT') continue;
    throw error;
  }
  await cp(source, join(publicRoot, directory), { recursive: true, force: true });
  console.log(`Copied PDF.js ${directory} (${(await readdir(source)).length} files)`);
}
