---
scope: [frontend]
files: [src/client/hooks/useConnectionTest.ts, src/client/hooks/useConnectionTest.test.ts]
issue: 317
source: review
date: 2026-04-03
---
When widening a hook's stored result shape (adding `metadata` to `TestResult`), the existing tests only asserted `success`/`message` on the state. A future destructuring change that drops `metadata` would pass all existing tests. Always assert that new optional fields survive into hook state verbatim — the hook is the bridge between API and UI, and silent field drops are invisible to adapter or route tests.
