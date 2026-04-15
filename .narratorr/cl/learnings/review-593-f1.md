---
scope: [core]
files: [src/core/download-clients/retry.ts]
issue: 593
source: review
date: 2026-04-15
---
A `() => void` callback slot in TypeScript still accepts `async` functions — the returned promise is silently discarded by the caller, but if it rejects, Node emits an unhandled rejection. Wrapping the call with `await Promise.resolve(callback())` catches both sync throws and async rejections. This pattern is required for any fire-and-forget callback contract.
