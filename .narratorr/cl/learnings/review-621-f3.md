---
scope: [backend]
files: [eslint-rules/no-raw-error-logging.cjs]
issue: 621
source: review
date: 2026-04-17
---
The ESLint autofix originally hardcoded `../utils/serialize-error.js` as the import path, which is wrong for files already inside `src/server/utils/` (they need `./serialize-error.js`). The fix uses `context.filename` to detect if the file is in the utils directory. Also fixed the import insertion to only search the top-level import block (breaking at first non-import statement) to avoid inserting imports mid-file after stray type imports.
