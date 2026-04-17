---
scope: [backend, services]
files: [eslint-rules/no-raw-error-logging.cjs, eslint.config.js]
issue: 621
date: 2026-04-17
---
ESLint autofix `fixer.insertTextAfter(lastImport, ...)` places imports after the lexically last `ImportDeclaration` in the file, which may be a mid-file type import (e.g., `monitor.ts` line 100, `books.ts` line 48). When files have mid-file imports, autofix inserts at the wrong location. After bulk autofix, always grep for the new import and check that line numbers are in the expected range (<30). Manual fixup needed for 4 of 39 files.
