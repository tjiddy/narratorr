---
scope: [frontend]
files: [src/client/components/SearchReleasesModal.test.tsx]
issue: 161
date: 2026-03-28
---
Coverage review subagents can miss test behaviors that live in separate top-level describe blocks in the same file. For SearchReleasesModal, the subagent reported "duration unknown banner" and "unsupported results section expansion" as UNTESTED even though they're covered by `describe('SearchReleasesModal duration unknown', ...)` and `describe('SearchReleasesModal unsupported results', ...)` blocks further down in the file. The subagent read only the first describe block. When a coverage report flags an item as untested, verify the claim manually before adding new tests.
