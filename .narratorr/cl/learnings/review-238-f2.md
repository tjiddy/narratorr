---
scope: [frontend]
files: [src/client/pages/book/useBookActions.test.ts]
issue: 238
source: review
date: 2026-03-31
---
When adding a new mutation to an existing hook, the test must assert ALL success side effects — not just the API call and toast. The existing mutations in `useBookActions` all had invalidation tests, but the new `deleteMutation` was missing one. Follow the pattern of sibling mutations in the same hook.
