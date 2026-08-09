import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const noRawErrorLogging = require('./eslint-rules/no-raw-error-logging.cjs');
const noTautologicalExpect = require('./eslint-rules/no-tautological-expect.cjs');
const noUnstampedMatchGeneration = require('./eslint-rules/no-unstamped-match-generation.cjs');

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.config.js',
      '**/*.config.ts',
      '**/drizzle/**',
      '**/coverage/**',
      'e2e/**',
      'eslint-rules/**',
      '.scratch/**',
    ],
  },

  js.configs.recommended,

  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2022,
      },
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  {
    files: ['**/src/client/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'error',
        { allowConstantExport: true },
      ],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },

  {
    files: ['**/src/server/**/*.ts', '**/src/core/**/*.ts', '**/src/db/**/*.ts', 'e2e/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },

  // Pino drops raw catch bindings from structured JSON logs.
  {
    files: ['**/src/server/**/*.ts'],
    ignores: ['**/*.test.ts'],
    plugins: {
      'narratorr': { rules: { 'no-raw-error-logging': noRawErrorLogging } },
    },
    rules: {
      'narratorr/no-raw-error-logging': 'error',
    },
  },

  // Only these hooks construct matched rows; every such write must carry a fresh generation stamp.
  {
    files: [
      '**/src/client/pages/library-import/useLibraryImport.ts',
      '**/src/client/pages/manual-import/useManualImport.ts',
    ],
    plugins: {
      'narratorr': { rules: { 'no-unstamped-match-generation': noUnstampedMatchGeneration } },
    },
    rules: {
      'narratorr/no-unstamped-match-generation': 'error',
    },
  },

  // Enforce production layer boundaries; tests deliberately use cross-layer fixtures and alignment imports.
  {
    files: ['**/src/client/**/*.{ts,tsx}'],
    ignores: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: ['**/server/**', '**/server/*'],
        paths: [{ name: 'fastify', message: 'fastify must not be imported from client code.' }],
      }],
    },
  },
  {
    files: ['**/src/shared/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: ['**/core/**', '**/core/*', '**/server/**', '**/server/*', '@core/**', '@core/*'],
      }],
    },
  },
  {
    files: ['**/src/core/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: ['**/server/**', '**/server/*'],
        paths: [{ name: 'fastify', message: 'core adapters must not import fastify; throw errors or return failures and let the calling service log.' }],
      }],
    },
  },
  {
    // Services must not import routes; compatibility tests may.
    files: ['**/src/server/services/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: ['**/routes/**', '**/routes/*'],
      }],
    },
  },
  {
    // Jobs must not import routes; tests may.
    files: ['**/src/server/jobs/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: ['**/routes/**', '**/routes/*'],
      }],
    },
  },
  {
    // Utils may import service types for signatures, never runtime values; tests may cross the boundary.
    files: ['**/src/server/utils/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['**/services/**', '**/services/*'],
          allowTypeImports: true,
          message: 'utils/ must not import service values — move service-coupled logic into services/ (import type is allowed).',
        }],
      }],
    },
  },

  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],

      // Without `await`, a returned rejection bypasses the surrounding catch.
      '@typescript-eslint/return-await': ['error', 'in-try-catch'],

      'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['error', { max: 150, skipBlankLines: true, skipComments: true }],
      'complexity': ['error', { max: 15 }],
      'prefer-const': 'error',
      'no-var': 'error',
      'no-useless-escape': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },

  // Relax test complexity limits while rejecting literal tautologies.
  {
    files: ['**/*.test.ts', '**/*.test.tsx'],
    plugins: {
      'narratorr': { rules: { 'no-tautological-expect': noTautologicalExpect } },
    },
    rules: {
      'max-lines': 'off',
      'max-lines-per-function': 'off',
      'complexity': 'off',
      'narratorr/no-tautological-expect': 'error',
      // Vitest partial mocks need erased inline `typeof import(...)` annotations.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports', disallowTypeAnnotations: false },
      ],
    },
  },

  // Drizzle's declarative catalog scales with the data model; splitting it to satisfy max-lines adds no value.
  {
    files: ['src/db/schema.ts'],
    rules: {
      'max-lines': 'off',
    },
  }
);
