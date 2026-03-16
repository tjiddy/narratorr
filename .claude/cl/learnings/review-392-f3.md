---
scope: [backend]
files: [src/server/services/retry-search.test.ts]
issue: 392
source: review
date: 2026-03-15
---
Reviewer caught yet another missed file in the settings fixture migration — `retry-search.test.ts` still had a hardcoded `quality` category literal in its `createDeps()` helper. This is the third round of the same category of finding (incomplete migration sweep). Root cause: each round's grep caught a different mock pattern but missed others. Prevention: after completing a migration, run a single comprehensive grep for the underlying method name (`settings.get`) combined with `mockResolvedValue({` across ALL test files, not pattern-specific greps.
