import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';

export default tseslint.config(
  // Ignore patterns
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.config.js',
      '**/*.config.ts',
      '**/drizzle/**',
    ],
  },

  // Base config for all files
  js.configs.recommended,

  // TypeScript config (recommended + type-checked for return-await)
  ...tseslint.configs.recommended,

  // Global settings
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

  // React config for client files
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
      // No console in client code
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },

  // Server-side code - allow console.log for logging
  {
    files: ['**/src/server/**/*.ts', '**/packages/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },

  // Custom rules for all files
  {
    rules: {
      // TypeScript
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

      // Async safety — catch blocks are dead code without `await` on returned promises
      '@typescript-eslint/return-await': ['error', 'in-try-catch'],

      // File hygiene
      'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['error', { max: 150, skipBlankLines: true, skipComments: true }],
      'complexity': ['error', { max: 15 }],
      // General
      'prefer-const': 'error',
      'no-var': 'error',
      'no-useless-escape': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },

  // Test files - relax rules that don't add value in tests
  {
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      'max-lines': 'off',
      'max-lines-per-function': 'off',
      'complexity': 'off',
    },
  }
);
