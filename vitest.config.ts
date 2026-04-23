import { defineConfig } from 'vitest/config';
import path from 'path';

const sharedConfig = {
  resolve: {
    alias: {
      '@core': path.resolve(__dirname, 'src/core'),
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
          include: [
            'src/server/**/*.test.ts',
            'src/shared/**/*.test.ts',
            'src/core/**/*.test.ts',
            'src/db/**/*.test.ts',
            'docker/**/*.test.ts',
            // Harness helper unit tests. Naming convention: .test.ts = vitest,
            // .spec.ts = Playwright. See e2e/README.md.
            'e2e/fixtures/**/*.test.ts',
            'e2e/fakes/**/*.test.ts',
            'e2e/*.test.ts',
          ],
        },
      },
    ],
  },
});
