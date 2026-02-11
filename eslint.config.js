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

  // TypeScript config
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
        'warn',
        { allowConstantExport: true },
      ],
      // No console in client code
      'no-console': ['warn', { allow: ['warn', 'error'] }],
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
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': [
        'warn',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],

      // General
      'prefer-const': 'warn',
      'no-var': 'error',
      'no-useless-escape': 'warn',
      eqeqeq: ['warn', 'always', { null: 'ignore' }],
    },
  },

  // Test files - relax no-explicit-any for mock patterns
  // TODO: Properly type test mock helpers to remove this override (see Gitea issue)
  {
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  }
);
