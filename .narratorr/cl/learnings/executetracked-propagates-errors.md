---
scope: [backend]
files: [src/server/jobs/index.test.ts, src/server/services/task-registry.ts]
issue: 477
date: 2026-04-11
---
`TaskRegistry.executeTracked()` has a `try/finally` but no `catch` — errors propagate to the caller. In production, `scheduleCron` wraps this in its own try/catch that logs errors. But when testing job callbacks directly via `executeTracked()`, thrown errors (like VACUUM failure) will reject the promise. Tests that assert on behavior after a thrown error must catch the rejection: `await executeTracked('name').catch(() => {})`.
