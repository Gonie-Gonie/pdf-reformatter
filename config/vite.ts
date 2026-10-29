import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

function basePath(): string {
  const override = process.env.APP_BASE?.trim();
  const repo = process.env.GITHUB_REPOSITORY?.split('/')[1];
  const base = override || (!repo || repo.endsWith('.github.io') ? '/' : `/${repo}/`);
  if (!base.startsWith('/') || !base.endsWith('/') || /[?#\\]/.test(base)) {
    throw new Error("APP_BASE must be an absolute URL path starting and ending in '/'.");
  }
  return base;
}

function buildId(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 8);
  try {
    return execFileSync('git', ['rev-parse', '--short=8', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'local';
  }
}

export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  cacheDir: '.cache/vite',
  publicDir: '.cache/public',
  plugins: [react()],
  base: basePath(),
  define: { __APP_VERSION__: JSON.stringify(`0.1.0+${buildId()}`) },
  worker: { format: 'es' },
  build: {
    outDir: '.cache/dist',
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 2500,
  },
});
