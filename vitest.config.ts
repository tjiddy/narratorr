import { defineConfig } from 'vitest/config';
import path from 'path';

const sharedConfig = {
  resolve: {
    // Vite matches prefixes in order, so `@` stays last. Omit `@server` to preserve the core/server boundary.
    alias: {
      '@core': path.resolve(import.meta.dirname, 'src/core'),
      '@shared': path.resolve(import.meta.dirname, 'src/shared'),
      '@db': path.resolve(import.meta.dirname, 'src/db'),
      '@': path.resolve(import.meta.dirname, 'src/client'),
    },
  },
};

export default defineConfig({
  ...sharedConfig,
  test: {
    passWithNoTests: true,
    // 249 server files build real temp trees, so worker count is filesystem contention, not CPU.
    // Uncapped on a 24-core machine the suite went non-deterministic — three symptoms of one
    // cause, all absent at 8: ENOTEMPTY on a recursive rm whose directory was empty, `Worker
    // exited unexpectedly`, and 15s timeouts on tests that run in 88ms alone.
    //
    // Two traps here, both of which have already bitten:
    //  - Spell it `maxWorkers`, NOT `poolOptions.forks.maxForks`. Vitest 4 removed the latter
    //    outright rather than aliasing it, so the v3 spelling caps nothing while emitting only a
    //    deprecation line — invisible in a 15-minute run.
    //  - Keep it at ROOT, not on the server project. Vitest 4 refuses to start when two projects
    //    have different `maxWorkers` under the same `sequence.groupOrder`, and giving them
    //    distinct groups serializes client behind server for no gain — disk is shared anyway.
    //
    // Core count is not the safe proxy it looks like: the binding resource is disk, so a 4-core
    // Windows runner can contend where a faster Linux one does not.
    maxWorkers: 8,
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
          // Full-app setup exceeded the default only under suite parallelism; see maxWorkers below.
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
            // RuleTester suites are ESM `.test.js`; a CommonJS script registers no Vitest tests.
            'eslint-rules/**/*.test.js',
          ],
        },
      },
    ],
  },
});
