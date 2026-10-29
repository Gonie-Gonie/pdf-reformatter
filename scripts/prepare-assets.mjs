import { cp, mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  assertGeneratedPath,
  removeGeneratedDirectory,
  root,
  temporaryRoot,
} from './workspace.mjs';

const destination = assertGeneratedPath(join(temporaryRoot, 'public'));
removeGeneratedDirectory(destination);
await mkdir(destination, { recursive: true });
await cp(join(root, 'public'), destination, {
  recursive: true,
  filter: (source) => !['pdfjs', 'licenses'].includes(basename(source)),
});
await import('./copy-pdf-assets.mjs');
await import('./copy-licenses.mjs');
