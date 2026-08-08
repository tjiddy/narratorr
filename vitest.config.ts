import { defineConfig } from 'vitest/config';
import path from 'path';

const sharedConfig = {
  resolve: {
    // Order matters: Vite matches alias prefixes in order, so '@' must stay LAST or it
    // would swallow '@core'/'@shared'/'@db'. There is deliberately no '@server' — server
    // is not a lower layer, and an alias for it would add a second way for src/core to
    // reach src/server past the `no-restricted-imports` boundary in eslint.config.js.
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
          // Server integration tests build a full Fastify app (swagger + route
          // registration + Zod compilers) in beforeAll. Under the full suite's
          // parallelism the CPU saturates and that setup can exceed the 10s default
          // hookTimeout, surfacing as an intermittent beforeAll failure (observed on
          // the v1 openapi spec suite) that passes in isolation. Give legitimately-
          // heavy setup headroom — a genuine hang still fails, just later.
          testTimeout: 15000,
          hookTimeout: 30000,
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
            // Local ESLint rule suites. `.test.js` only: the two legacy `.test.cjs`
            // scripts here register no vitest tests and would fail the run outright.
            'eslint-rules/**/*.test.js',
          ],
        },
      },
    ],
  },
});
