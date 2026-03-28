---
scope: [backend, services]
files: [src/server/plugins/error-handler.ts, src/server/services/task-registry.ts]
issue: 149
date: 2026-03-26
---
When importing a named export that doesn't exist yet, the import resolves to `undefined`. Adding `undefined` to the `ERROR_REGISTRY` Map causes `error instanceof undefined` to throw `TypeError`, breaking the entire error-handler plugin for ALL errors — validation errors return 500 instead of 400. Always define the error class before registering it, or define + register in the same commit.
