---
scope: [frontend]
files: [src/client/pages/activity/ActivityPage.test.tsx]
issue: 414
source: review
date: 2026-04-08
---
When testing that a `useEffect` dependency changed from an unstable object to a stable callback, the test must prove the effect doesn't re-run when it shouldn't. If the effect body is idempotent (e.g., `clampToTotal` is a no-op for valid pages), behavioral assertions (page labels, API calls) are vacuous — they pass on both old and new code. Use a spy wrapper on the hook to count invocations instead. A `WeakMap<OriginalFn, WrapperFn>` cache preserves referential stability so the spy doesn't break the production code's stable deps.
