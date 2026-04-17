---
scope: [backend, services]
files: [src/server/utils/import-steps.ts]
issue: 621
source: review
date: 2026-04-17
---
ESLint autofix missed one call site (`handleImportFailure` line 393) because the `error` variable there was used both as a function parameter (not a catch clause binding) and in a log call. The rule only detects CatchClause and .catch() callback parameter definitions. The site was manually identified by the reviewer. Lesson: after bulk autofix, verify AC4 by also running a manual grep for remaining `{ error` patterns in log calls across changed files.
