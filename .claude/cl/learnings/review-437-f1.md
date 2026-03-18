---
scope: [scope/backend]
files: [src/server/services/metadata.service.ts, src/server/services/metadata.service.test.ts]
issue: 437
source: review
date: 2026-03-18
---
Reviewer caught that the zero-search-provider path had no direct test coverage. When refactoring a constructor to use a registry, the empty-registry case becomes a real supported mode. The implementation had `!provider` guards but no test proved they worked after the registry change. Prevention: when a refactor makes a previously theoretical code path real (e.g., empty registry), add a test for that path in the same commit.
