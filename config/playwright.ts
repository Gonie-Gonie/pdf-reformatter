import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const repo = process.env.GITHUB_REPOSITORY?.split('/')[1];
const basePath =
  process.env.APP_BASE?.trim() || (!repo || repo.endsWith('.github.io') ? '/' : `/${repo}/`);
const baseURL = `http://127.0.0.1:4173${basePath}`;

export default defineConfig({
  testDir: resolve(root, 'tests/e2e'),
  outputDir: resolve(root, '.cache/test-results'),
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    acceptDownloads: true,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    cwd: root,
    command:
      'node node_modules/vite/bin/vite.js preview --config config/vite.ts --configLoader native --host 127.0.0.1 --port 4173 --strictPort',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
