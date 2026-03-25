---
name: review-93-r2-f2
description: Adding placeholderData to a hook requires a matching test that proves the previous-data stability contract
scope: [scope/frontend]
files: [src/client/hooks/useEventHistory.ts, src/client/hooks/useEventHistory.test.ts]
issue: 93
source: review
date: 2026-03-25
---
When `placeholderData: (prev) => prev` is added to a `useQuery` call as a production bug fix, the fix itself is untested unless a test explicitly verifies that stale data persists while the new query key is loading. Without the test, the `placeholderData` option could be silently removed and no test would fail.

**Why missed:** The production fix was treated as a blast-radius application of the `useActivity.ts` fix (sibling pattern check). The blast-radius check identified the hook as needing the fix, but did not trigger a requirement to add a corresponding test for each hook.

**What would have prevented it:** Any non-trivial option added to `useQuery` (especially `placeholderData`, `select`, `staleTime`) that changes observable hook behavior must have a test that directly exercises that behavior — not just the base query path. The sibling blast-radius grep finds files to fix; a follow-on pass must ask "does each fixed file have a test for this new behavior?"
