import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  generatedDirectories,
  removeGeneratedDirectory,
  root,
  toolEnvironment,
} from './workspace.mjs';
const tools = {
  vite: 'vite/bin/vite.js',
  tsc: 'typescript/bin/tsc',
  eslint: 'eslint/bin/eslint.js',
  vitest: 'vitest/vitest.mjs',
  playwright: '@playwright/test/cli.js',
  prettier: 'prettier/bin/prettier.cjs',
};
const help = `PDF Reflow developer commands
  run setup          Install dependencies/browsers/assets; verify the complete setup
  run dev            Start the local app
  run test           Run all checks, build and browser tests
  run test-unit      Run unit tests
  run test-e2e       Prepare fixtures, build and run browser tests
  run check          Run checks and build, without browser tests
  run build          Build the GitHub Pages site
  run preview        Build and preview the site
  run lint           Check source code
  run typecheck      Check TypeScript
  run format         Format source code
  run format-check   Check formatting
  run clean-repo     Delete generated outputs/caches; retain source and dependencies
  run help           Show this help
PowerShell: .\\run <command>. Other platforms: node scripts/run.mjs <command>.
Generated test files, browsers, downloads and builds use .cache/.
`;
class CommandError extends Error {
  constructor(message, status = 1) {
    super(message);
    this.status = status;
  }
}
function execute(entry, args = []) {
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd: root,
    env: toolEnvironment(),
    stdio: 'inherit',
  });
  if (result.error) throw new CommandError(result.error.message);
  if (result.status !== 0) throw new CommandError(`Command failed: ${entry}`, result.status ?? 130);
}
function tool(name, args = []) {
  const entry = join(root, 'node_modules', tools[name]);
  if (!existsSync(entry))
    throw new CommandError('Development dependencies are missing. Run "run setup" first.');
  execute(entry, args);
}
function script(name) {
  execute(join(root, 'scripts', name));
}
function assets() {
  script('prepare-assets.mjs');
}
function fixtures() {
  script('generate-fixture.mjs');
}
function build(args = []) {
  assets();
  tool('tsc', ['-b']);
  tool('vite', ['build', '--config', 'config/vite.ts', '--configLoader', 'native', ...args]);
}
function unit(args = []) {
  const folder = join(root, 'tests', 'tooling');
  const files = readdirSync(folder)
    .filter((name) => name.endsWith('.test.mjs'))
    .map((name) => join(folder, name));
  execute('--test', files);
  tool('vitest', ['run', '--config', 'config/vitest.ts', '--configLoader', 'native', ...args]);
}
function format(check = false, args = []) {
  tool('prettier', [check ? '--check' : '--write', '.', '--ignore-path', '.gitignore', ...args]);
}
function check() {
  tool('tsc', ['-b', '--pretty', 'false']);
  tool('eslint', ['--config', 'config/eslint.js', '.']);
  format(true);
  unit();
  build();
}
function browsers() {
  tool('playwright', ['install', 'chromium']);
}
function browserTests(args = [], alreadyBuilt = false) {
  fixtures();
  if (!alreadyBuilt) build();
  browsers();
  tool('playwright', ['test', '--config', 'config/playwright.ts', ...args]);
}
function setup() {
  const npm = [
    process.env.npm_execpath,
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].find((candidate) => candidate && existsSync(candidate) && candidate.endsWith('npm-cli.js'));
  if (!npm)
    throw new CommandError(
      'npm is missing. Install Node.js 24 with npm, or use run setup on Windows.',
    );
  execute(npm, ['ci', '--no-fund']);
  check();
  browserTests([], true);
  console.log('\nSetup complete. Use "run dev" or "run test".');
}
const [requestedCommand = 'help', ...args] = process.argv.slice(2);
const command = requestedCommand.toLowerCase();
const handlers = {
  setup,
  dev: () => {
    assets();
    tool('vite', [
      '--config',
      'config/vite.ts',
      '--configLoader',
      'native',
      '--host',
      '127.0.0.1',
      ...args,
    ]);
  },
  test: () => {
    check();
    browserTests(args, true);
  },
  'test-unit': () => unit(args),
  'test:unit': () => unit(args),
  'test-e2e': () => browserTests(args),
  'test:e2e': () => browserTests(args),
  check,
  build: () => build(args),
  preview: () => {
    build();
    tool('vite', [
      'preview',
      '--config',
      'config/vite.ts',
      '--configLoader',
      'native',
      '--host',
      '127.0.0.1',
      ...args,
    ]);
  },
  lint: () => tool('eslint', ['--config', 'config/eslint.js', '.', ...args]),
  typecheck: () => tool('tsc', ['-b', '--pretty', 'false', ...args]),
  format: () => format(false, args),
  'format-check': () => format(true, args),
  'clean-repo': () => {
    if (args.length) throw new CommandError('clean-repo does not accept paths or flags.', 2);
    for (const directory of generatedDirectories) removeGeneratedDirectory(directory);
    console.log(
      'Removed temporary outputs and tool caches. Source, node_modules and the local Node.js runtime are retained.',
    );
  },
};
try {
  if (['help', '--help', '-h'].includes(command)) console.log(help);
  else if (!Object.hasOwn(handlers, command))
    throw new CommandError(`Unknown command: ${command}\nUse "run help".`, 2);
  else {
    const expected = readFileSync(join(root, '.node-version'), 'utf8').trim().split('.')[0];
    if (process.versions.node.split('.')[0] !== expected)
      throw new CommandError(
        `Node.js ${expected} is required. On Windows, run setup prepares a local runtime automatically.`,
      );
    if (['setup', 'check'].includes(command) && args.length)
      throw new CommandError(`${command} does not accept flags.`, 2);
    handlers[command]();
  }
} catch (error) {
  console.error(`\n${error.message}`);
  process.exitCode = error instanceof CommandError ? error.status : 1;
}
