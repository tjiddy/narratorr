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
      'src/shared/**/*.test.ts',
      'src/core/**/*.test.ts',
      'src/db/**/*.test.ts',
      'scripts/**/*.test.ts',
      'docker/**/*.test.ts',
    ],
    passWithNoTests: true,
    environmentMatchGlobs: [
      ['src/client/**', 'jsdom'],
      ['src/server/**', 'node'],
      ['src/core/**', 'node'],
      ['src/db/**', 'node'],
    ],
    setupFiles: ['src/client/__tests__/setup.ts'],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      exclude: ['scripts/**', 'src/server/index.ts', 'src/client/main.tsx'],
    },
  },
});
