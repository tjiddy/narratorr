---
skill: respond-to-pr-review
issue: 58
pr: 59
round: 1
date: 2026-03-22
fixed_findings: [F1, F2]
---

### F1: cancelQueries missing before onMutate cache patch
**What was caught:** `deleteMutation.onMutate` patched the activity cache without first cancelling in-flight activity queries. A stale refetch (triggered by SSE via `useEventSource.ts:60-63`) could resolve after the optimistic patch and repopulate the deleted row, recreating the flicker.

**Why I missed it:** The spec described the fix as "use `setQueryData()` in `onMutate`" and I focused on implementing that correctly with snapshot/restore. The concurrent-refetch race was listed in the codebase exploration (SSE interaction) but was not part of the test plan requirements, so it wasn't translated into implementation.

**Prompt fix:** Add to `/implement` step 4 (green phase) for optimistic updates: "When implementing `onMutate` with cache patching, always start with `await queryClient.cancelQueries({ queryKey: [...base key...] })` to prevent in-flight queries from overwriting the optimistic state. This is required whenever the same query key is invalidated from concurrent sources (SSE, other mutations)."

### F2: Missing stale-refetch race test
**What was caught:** The test suite proved snapshot/restore correctness but did not include a test that starts with a concurrent in-flight query and verifies it cannot overwrite the optimistic removal. Without this test, the missing `cancelQueries` passed the full suite.

**Why I missed it:** The test plan (from the spec) listed the timing guarantee ("assert removal before API resolves") via a deferred promise pattern, which I implemented. But the spec didn't explicitly call out the concurrent-refetch variant where an EXISTING in-flight query (not the delete API call) is the threat. The deferred promise in the existing tests held the delete API deferred, not a parallel activity refetch.

**Prompt fix:** Add to `/plan` step 5 (test stubs) for optimistic updates: "For every optimistic mutation that patches a query key, generate a stub for: 'in-flight refetch race — start a background refetch for the same query key, trigger the mutation before the refetch resolves, assert the optimistic change survives when the stale refetch response lands.' This test is the only way to catch missing `cancelQueries` before it reaches review."
