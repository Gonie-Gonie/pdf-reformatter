import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import {
  assertGeneratedPath,
  generatedDirectories,
  removeGeneratedDirectory,
  root,
  temporaryRoot,
  toolEnvironment,
} from '../../scripts/workspace.mjs';

const scratch = join(temporaryRoot, 'tooling-tests', `${process.pid}-${randomUUID()}`);
assertGeneratedPath(scratch);
mkdirSync(scratch, { recursive: true });
after(() => removeGeneratedDirectory(scratch));

function folder(name) {
  const path = join(scratch, name);
  mkdirSync(path, { recursive: true });
  return path;
}

function invoke(args, options = {}) {
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'run.mjs'), ...args], {
    cwd: scratch,
    encoding: 'utf8',
    shell: false,
    ...options,
  });
  assert.ifError(result.error);
  return result;
}

test('only declared generated paths and their descendants are accepted', () => {
  for (const path of generatedDirectories) {
    assert.equal(assertGeneratedPath(path), path);
    assert.equal(
      assertGeneratedPath(join(path, 'nested', 'result.pdf')),
      join(path, 'nested', 'result.pdf'),
    );
  }
  for (const path of [
    root,
    join(root, 'src'),
    join(root, 'tests'),
    join(root, 'node_modules'),
    join(root, '.tools'),
    resolve(root, '..', 'outside-workspace'),
    resolve(temporaryRoot, '..', 'src'),
  ]) {
    assert.throws(() => assertGeneratedPath(path), /Refusing non-generated path/);
    assert.throws(() => removeGeneratedDirectory(path), /Refusing non-generated path/);
  }
});

test('cleanup removes only the selected generated subtree and is idempotent', () => {
  const area = folder('selected-cleanup');
  const keep = join(area, 'keep.txt');
  const remove = join(area, 'results');
  mkdirSync(join(remove, 'nested'), { recursive: true });
  writeFileSync(join(remove, 'nested', 'output.txt'), 'discard');
  writeFileSync(keep, 'preserve');
  removeGeneratedDirectory(remove);
  assert.equal(existsSync(remove), false);
  assert.equal(readFileSync(keep, 'utf8'), 'preserve');
  assert.doesNotThrow(() => removeGeneratedDirectory(remove));
});

test('cleanup unlinks a leaf directory link and preserves its target and siblings', () => {
  const area = folder('leaf-link');
  const target = join(area, 'keep-target');
  const link = join(area, 'results-link');
  mkdirSync(target);
  writeFileSync(join(target, 'keep.txt'), 'target survives');
  writeFileSync(join(area, 'sibling.txt'), 'sibling survives');
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  removeGeneratedDirectory(link);
  assert.equal(existsSync(link), false);
  assert.equal(readFileSync(join(target, 'keep.txt'), 'utf8'), 'target survives');
  assert.equal(readFileSync(join(area, 'sibling.txt'), 'utf8'), 'sibling survives');
});

test('recursive cleanup does not follow directory links inside generated output', () => {
  const area = folder('nested-directory-link');
  const target = join(area, 'keep-target');
  const remove = join(area, 'results');
  mkdirSync(target);
  mkdirSync(remove);
  writeFileSync(join(target, 'keep.txt'), 'recursive target survives');
  symlinkSync(
    target,
    join(remove, 'nested-link'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  removeGeneratedDirectory(remove);
  assert.equal(existsSync(remove), false);
  assert.equal(readFileSync(join(target, 'keep.txt'), 'utf8'), 'recursive target survives');
});

test('cleanup rejects traversal through a parent directory link', () => {
  const area = folder('parent-link');
  const target = join(area, 'keep-target');
  const link = join(area, 'parent-link');
  mkdirSync(join(target, 'nested'), { recursive: true });
  const keep = join(target, 'nested', 'keep.txt');
  writeFileSync(keep, 'parent target survives');
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  const throughLink = join(link, 'nested');
  assert.throws(() => assertGeneratedPath(throughLink), /Refusing directory link/);
  assert.throws(() => removeGeneratedDirectory(throughLink), /Refusing directory link/);
  assert.equal(readFileSync(keep, 'utf8'), 'parent target survives');
  removeGeneratedDirectory(link);
});

test('cleanup rejects dangling parent directory links', () => {
  const area = folder('dangling-parent-link');
  const link = join(area, 'parent-link');
  symlinkSync(
    join(area, 'missing-target'),
    link,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  try {
    assert.equal(existsSync(link), false);
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.throws(() => assertGeneratedPath(join(link, 'nested')), /Refusing directory link/);
  } finally {
    removeGeneratedDirectory(link);
  }
});

test('tool environment keeps browser, npm and OS temporary paths inside the workspace', () => {
  const before = { TMP: process.env.TMP, TEMP: process.env.TEMP, TMPDIR: process.env.TMPDIR };
  const env = toolEnvironment();
  assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, join(temporaryRoot, 'playwright'));
  assert.equal(env.npm_config_cache, join(temporaryRoot, 'npm'));
  for (const key of ['TMP', 'TEMP', 'TMPDIR']) {
    assert.equal(env[key], join(temporaryRoot, 'tmp'));
    assert.equal(process.env[key], before[key]);
  }
  assert.equal(existsSync(env.TMP), true);
  assert.equal(env.PATH.split(delimiter)[0], dirname(process.execPath));
  assert.deepEqual(
    Object.keys(env).filter((key) => key.toUpperCase() === 'PATH'),
    ['PATH'],
  );
});

test('help works in a copy with no Node packages or project configuration', () => {
  const isolated = folder('without-dependencies');
  const scripts = join(isolated, 'scripts');
  mkdirSync(scripts);
  for (const filename of ['run.mjs', 'workspace.mjs']) {
    copyFileSync(join(root, 'scripts', filename), join(scripts, filename));
  }
  assert.equal(existsSync(join(isolated, 'node_modules')), false);
  const result = spawnSync(process.execPath, [join(scripts, 'run.mjs'), 'help'], {
    cwd: isolated,
    encoding: 'utf8',
    shell: false,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /run setup/);
  assert.match(result.stdout, /run clean-repo/);
});

test('CLI locates the repository when invoked from a different working directory', () => {
  const foreignDirectory = folder('other working directory 한글');
  const result = invoke(['help'], { cwd: foreignDirectory });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PDF Reflow developer commands/);
});

test('unknown commands fail with exit code 2', () => {
  const result = invoke(['not-a-command']);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /Unknown command: not-a-command/);
});

test('clean-repo rejects all supplied paths or flags before removing files', () => {
  const keep = join(folder('flag-rejection'), 'keep.txt');
  writeFileSync(keep, 'must not clean');
  for (const argument of ['--all', '..', 'node_modules', '--help']) {
    const result = invoke(['clean-repo', argument]);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /clean-repo does not accept paths or flags/);
    assert.equal(readFileSync(keep, 'utf8'), 'must not clean');
  }
});
