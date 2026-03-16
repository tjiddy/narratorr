---
scope: [scope/backend, scope/services]
files: [src/server/routes/books.ts]
issue: 357
source: spec-review
date: 2026-03-13
---
Spec review caught that `triggerImmediateSearch` in `routes/books.ts:28-66` is a 4th copy of the search-and-grab loop that the spec omitted from its scope. The `/elaborate` subagent found the function but didn't flag it as a duplication instance — it was identified as a touch point (import from jobs) but not as containing its own inline search→filter→rank→grab sequence.

Root cause: The elaboration explored the file paths named in the issue findings but didn't independently scan for additional instances of the duplicated pattern. When a spec is about deduplication, the elaboration should grep for all instances of the duplicated code pattern, not just validate the ones the spec already names.
