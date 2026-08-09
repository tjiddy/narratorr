import { defineConfig } from 'vitest/config';
import path from 'path';

const sharedConfig = {
  resolve: {
    // Vite matches prefixes in order, so `@` stays last. Omit `@server` to preserve the core/server boundary.
    alias: {
      '@core': path.resolve(__dirname, 'src/core'),
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@db': path.resolve(__dirname, 'src/db'),
      '@': path.resolve(__dirname, 'src/client'),
    },
  },
};

export default defineConfig({
  ...sharedConfig,
  test: {
    passWithNoTests: true,
    coverage: {
      provider: 'v8' as const,
      reportsDirectory: 'coverage',
      exclude: ['src/server/index.ts', 'src/client/main.tsx'],
    },
    projects: [
      {
        ...sharedConfig,
        test: {
          name: 'client',
          environment: 'jsdom',
          include: ['src/client/**/*.test.{ts,tsx}'],
          setupFiles: ['src/client/__tests__/setup.ts'],
        },
      },
      {
        ...sharedConfig,
        test: {
          name: 'server',
          environment: 'node',
          // Full-app setup exceeded the default only under suite parallelism; retain bounded headroom.
          testTimeout: 15000,
          hookTimeout: 30000,
          include: [
            'src/server/**/*.test.ts',
            'src/shared/**/*.test.ts',
            'src/core/**/*.test.ts',
            'src/db/**/*.test.ts',
            'docker/**/*.test.ts',
            // E2E helpers use `.test.ts`; browser specs use `.spec.ts`.
            'e2e/fixtures/**/*.test.ts',
            'e2e/fakes/**/*.test.ts',
            'e2e/*.test.ts',
            // Legacy `.test.cjs` scripts register no Vitest tests, so include only `.test.js`.
            'eslint-rules/**/*.test.js',
          ],
        },
      },
    ],
  },
});
