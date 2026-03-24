---
scope: [backend]
files: [src/server/jobs/index.ts]
issue: 430
date: 2026-03-18
---
When extracting job callbacks into a typed registry array, `() => Promise<void> | void` is too narrow — many job functions return `Promise<SearchJobResult>` etc. Use `() => Promise<unknown> | unknown` for the registry type, then cast to `() => Promise<unknown>` at the `reg.register()` call site since TaskRegistry.register expects that signature.
