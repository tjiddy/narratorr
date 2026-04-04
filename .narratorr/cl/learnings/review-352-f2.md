---
scope: [frontend]
files: [src/client/pages/library/useLibraryFilters.test.tsx]
issue: 352
source: review
date: 2026-04-04
---
Reviewer caught that no test would fail if `{ replace: true }` were removed from the setSearchParams call. MemoryRouter doesn't expose history length or push-vs-replace distinction in any observable way from jsdom tests. The pragmatic solution is a source-level assertion (`readFileSync` + `toContain('{ replace: true }')`) combined with behavioral assertions that the URL reflects complete filter state. Prevention: for options like `{ replace: true }` that affect browser behavior but not URL content, plan a source-level or spy-based assertion upfront.
