import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  cacheDir: '.cache/vitest',
  test: {
    include: ['tests/unit/**/*.test.ts'],
    fsModuleCachePath: fileURLToPath(new URL('../.cache/vitest-modules', import.meta.url)),
    coverage: { reportsDirectory: '.cache/coverage' },
  },
});
