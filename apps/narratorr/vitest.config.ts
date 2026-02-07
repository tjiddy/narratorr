import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src/client') },
  },
  test: {
    include: [
      'src/server/**/*.test.ts',
      'src/client/**/*.test.{ts,tsx}',
    ],
    passWithNoTests: true,
    environmentMatchGlobs: [
      ['src/client/**', 'jsdom'],
      ['src/server/**', 'node'],
    ],
    setupFiles: ['src/client/__tests__/setup.ts'],
    coverage: { provider: 'v8', reportsDirectory: 'coverage' },
  },
});
