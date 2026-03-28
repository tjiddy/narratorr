---
skill: respond-to-pr-review
issue: 63
pr: 65
round: 2
date: 2026-03-24
fixed_findings: [F4]
---

### F4: confirmed retry failure leaves confirmation modal open

**What was caught:** After the user confirms replacement and the retry grab fails (non-409), the `onError` handler only called `toast.error(...)` but never cleared `pendingReplace`. The confirm modal stayed open.

**Why I missed it:** I only traced the happy path (`onSuccess` calls `setPendingReplace(null)`) and the 409 error path (opens the confirm modal). I didn't trace the non-409 error path while `pendingReplace` was already set — i.e., the confirmed retry failure scenario. The error handler's else-branch runs in both the initial-grab and confirmed-retry contexts, but I only verified the initial-grab case.

**Prompt fix:** Add to `/implement` step for modal components with multi-step flows: "For any `onError` handler that conditionally sets or opens modal state, verify that *every* branch of the error handler correctly resets that state. Trace all contexts from which the mutation can be called (initial call, retry, etc.) and ensure the error path handles cleanup symmetrically with the success path."
