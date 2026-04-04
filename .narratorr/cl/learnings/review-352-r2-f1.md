---
scope: [frontend]
files: [src/client/pages/library/useLibraryFilters.replace.test.tsx]
issue: 352
source: review
date: 2026-04-04
---
Source-text assertions (`readFileSync().toContain(...)`) are insufficient for testing runtime behavior — they don't execute the code path and can't catch regressions where the literal remains but usage changes. For testing options passed to framework hooks like `setSearchParams(params, { replace: true })`, use `vi.mock` to wrap the hook and capture the actual call arguments at runtime. This requires a separate test file since `vi.mock` is file-scoped.
