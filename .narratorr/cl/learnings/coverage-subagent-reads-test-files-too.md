---
scope: [frontend, backend]
files: [src/shared/schemas/indexer.test.ts, src/shared/schemas/download-client.test.ts, src/shared/schemas/notifier.test.ts]
issue: 284
date: 2026-04-01
---
Coverage review subagent may report false negatives if it only reads source file diffs without reading the corresponding test files. When all new behaviors are tested in co-located test files (added in the same branch), the subagent must be explicitly told to read `git diff main --name-only -- '*.test.*'` and cross-reference — otherwise it flags every behavior as "UNTESTED" even when comprehensive tests exist.
