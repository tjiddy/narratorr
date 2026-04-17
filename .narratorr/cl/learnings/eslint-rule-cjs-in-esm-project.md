---
scope: [backend]
files: [eslint-rules/no-raw-error-logging.cjs, eslint.config.js]
issue: 621
date: 2026-04-17
---
Custom ESLint rules in an ESM project (`"type": "module"`) must use `.cjs` extension and be loaded via `createRequire(import.meta.url)` in `eslint.config.js`. Using `.js` with `module.exports` fails because Node treats `.js` as ESM. Also, the rule file must be added to ESLint's `ignores` array to prevent ESLint from trying to lint the CJS file with TypeScript parser.
