---
name: async-preflight-vs-async-work
description: Pre-flight validation must happen before job creation, not inside the async work function — otherwise route error handlers become dead code
type: feedback
scope: [backend, services, api]
files: [src/server/services/bulk-operation.service.ts, src/server/routes/bulk-operations.ts]
issue: 135
date: 2026-03-26
---

When a service method creates a background job (fire-and-forget with `.start()`), any pre-flight checks MUST happen before the job is created, not inside the async work function. Checks inside the async work throw after the method returns — the caller (route) has already returned 202 and cannot catch them.

Pattern:
```ts
// WRONG — throws inside async work, unreachable by caller:
startJob(): string {
  assertNoActiveJob();
  const job = new Job(async () => {
    const settings = await getSettings();
    if (!settings.path) throw new Error('not configured'); // caller can't catch this
  });
  return job.id;
}

// CORRECT — throws synchronously before job creation:
async startJob(): Promise<string> {
  assertNoActiveJob();
  const settings = await getSettings();
  if (!settings.path) throw new Error('not configured'); // caller catches this
  const job = new Job(async () => { /* use closed-over settings */ });
  return job.id;
}
```

**Why:** The coverage review found that the route's 400/503 error handlers were dead code — the real service never reached them because the throw happened inside fire-and-forget async work. The route mock in tests was throwing synchronously, masking the bug.

**How to apply:** Whenever a service method starts a background job and the route has error handling for specific throw codes, verify the throws can actually propagate to the route. If the throws happen inside a fire-and-forget async callback, they must be moved to the synchronous preamble (making the method async if needed).
