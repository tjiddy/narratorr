---
name: review-63-f4 confirmed-retry-failure-modal-cleanup
description: After a replacement grab retry fails, the confirm modal must be explicitly cleared
type: feedback
---

When a TanStack Query mutation's `onError` handler both opens a modal (via state set) and shows an error toast, the non-error branch must also explicitly *close* that modal. The 409 branch sets `pendingReplace` (opens confirm modal). The catch-all branch only showed a toast — so if the confirmed retry failed, `pendingReplace` was still set, leaving the confirm modal visible.

**Why:** The modal open/close is managed entirely by `pendingReplace !== null`. On a non-409 error, there's no automatic reset — the component doesn't know whether the error came from an initial grab or a confirmed retry without checking state. Calling `setPendingReplace(null)` unconditionally in the else branch is safe: if no replace was pending, it's a no-op.

**How to apply:** Whenever an `onError` handler can fire from two different call contexts (initial request vs. confirmed retry), audit both paths to ensure modal/state cleanup is symmetrical. If the success branch clears state, every error branch that doesn't re-use it should also clear it.
