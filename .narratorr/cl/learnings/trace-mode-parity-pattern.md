---
scope: [backend]
files: [src/server/utils/folder-parsing.ts, src/server/utils/search-helpers.ts]
issue: 446
date: 2026-04-09
---
When adding a "trace mode" variant of an existing function (to capture intermediate steps), create a separate function (`fooWithTrace()`) rather than adding a boolean flag to the original. This avoids changing the return type of the original function (which would require updating all callers) and keeps the trace function independently testable. The parity test (`trace.result === original(input)` for many inputs) is the highest-value test — it catches drift between the two implementations.
