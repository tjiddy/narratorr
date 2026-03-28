---
scope: [backend, core, frontend]
files: [src/core/import-lists/abs-provider.test.ts, src/core/import-lists/hardcover-provider.test.ts, src/core/import-lists/nyt-provider.test.ts]
issue: 147
date: 2026-03-27
---
When appending `it.todo()` stubs to existing test files using shell heredoc (`cat >>`), they land AFTER the closing `});` of the main `describe` block — creating syntax-valid but semantically misplaced tests. Always verify stub placement (inside the correct `describe` block) before converting them to real tests. In this case, the stubs also used the wrong method name (`testConnection` vs `test()`). Reading the source file before writing stubs prevents both issues.
