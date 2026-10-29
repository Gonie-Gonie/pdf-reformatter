import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const destination = join(root, '.cache', 'public', 'licenses');
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
await mkdir(destination, { recursive: true });
const index = [];
for (const [path, metadata] of Object.entries(lock.packages)) {
  if (!path || metadata.dev || !path.startsWith('node_modules/')) continue;
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(root, path, 'package.json'), 'utf8'));
  } catch {
    continue; // Optional platform-only packages may not be installed on this machine.
  }
  const safeName = manifest.name.replace(/[^a-z\d-]/gi, '-').replace(/^-+/, '');
  const entries = await readdir(join(root, path));
  const files = entries.filter((name) =>
    /^(licen[cs]e|notice|copying|copyright)(\.|$)/i.test(name),
  );
  for (const file of files) {
    await cp(join(root, path, file), join(destination, `${safeName}-${file}`));
  }
  index.push({
    name: manifest.name,
    version: manifest.version,
    license: manifest.license,
    repository: manifest.repository,
    files,
  });
}
const fontkitRoot = join(root, 'node_modules', '@pdf-lib', 'fontkit');
await cp(join(fontkitRoot, 'README.md'), join(destination, 'pdf-lib-fontkit-README.md'));
const bundle = await readFile(join(fontkitRoot, 'dist', 'fontkit.es.js'), 'utf8');
const notices = [...bundle.matchAll(/\/\*[\s\S]*?\*\//g)]
  .map(([comment]) => comment)
  .filter((comment) => /copyright|licen[cs]e|permission is hereby/i.test(comment));
await writeFile(join(destination, 'pdf-lib-fontkit-bundled-notices.txt'), notices.join('\n\n'));
await writeFile(join(destination, 'index.json'), JSON.stringify(index, null, 2) + '\n');
await cp(
  join(root, 'legal', 'THIRD_PARTY_NOTICES.md'),
  join(destination, 'THIRD_PARTY_NOTICES.md'),
);
await cp(join(root, 'legal', 'fonts.json'), join(destination, 'fonts.json'));
console.log(`Copied runtime licenses for ${index.length} installed packages`);
