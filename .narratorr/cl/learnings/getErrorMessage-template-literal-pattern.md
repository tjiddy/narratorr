---
scope: [frontend]
files: [src/client/pages/book/useBookActions.ts, src/client/hooks/useEventHistory.ts]
issue: 513
date: 2026-04-12
---
When adopting `getErrorMessage(error, fallback)` in toast calls, do NOT collapse template literals with prefixes. `toast.error(\`Prefix: ${error.message}\`)` must become `toast.error(\`Prefix: ${getErrorMessage(error)}\`)`, NOT `toast.error(getErrorMessage(error, 'Prefix'))`. The latter loses the prefix when error IS an Error (getErrorMessage returns error.message, ignoring the fallback). This caused 26 test failures that required a fix commit. Subagents doing bulk mechanical replacements should be given explicit examples of both the simple and template-literal patterns.
