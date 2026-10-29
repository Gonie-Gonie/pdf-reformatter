import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
export const root = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
export const temporaryRoot = join(root, '.cache');
export const generatedDirectories = [
  temporaryRoot,
  ...['.tmp', '.vite', '.vite-temp', '.vitest-cache'].map((name) =>
    join(root, 'node_modules', name),
  ),
  join(root, 'public', 'pdfjs'),
  join(root, 'public', 'licenses'),
];
export function assertGeneratedPath(candidate) {
  const target = resolve(candidate),
    rel = relative(root, target);
  if (
    !generatedDirectories.some((d) => target === d || target.startsWith(d + sep)) ||
    !rel ||
    rel.startsWith('..') ||
    isAbsolute(rel)
  )
    throw new Error(`Refusing non-generated path: ${target}`);
  for (let parent = dirname(target); parent !== root; parent = dirname(parent)) {
    try {
      if (lstatSync(parent).isSymbolicLink()) throw new Error(`Refusing directory link: ${parent}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return target;
}
export function removeGeneratedDirectory(candidate) {
  const target = assertGeneratedPath(candidate);
  let info;
  try {
    info = lstatSync(target);
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  if (info.isSymbolicLink()) unlinkSync(target);
  else rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}
export function toolEnvironment() {
  assertGeneratedPath(join(temporaryRoot, 'tmp'));
  if (existsSync(temporaryRoot) && lstatSync(temporaryRoot).isSymbolicLink())
    throw new Error('Temporary workspace must not be a directory link.');
  const temp = join(temporaryRoot, 'tmp');
  mkdirSync(temp, { recursive: true });
  const env = { ...process.env };
  const currentPath = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  const set = (name, value) => {
    for (const key of Object.keys(env))
      if (key.toUpperCase() === name.toUpperCase()) delete env[key];
    env[name] = value;
  };
  set('PATH', dirname(process.execPath) + (process.platform === 'win32' ? ';' : ':') + currentPath);
  set('PLAYWRIGHT_BROWSERS_PATH', join(temporaryRoot, 'playwright'));
  set('npm_config_cache', join(temporaryRoot, 'npm'));
  set('NODE_COMPILE_CACHE', join(temporaryRoot, 'node-compile'));
  for (const name of ['TMP', 'TEMP', 'TMPDIR']) set(name, temp);
  return env;
}
