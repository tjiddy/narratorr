---
scope: [backend, services]
files: [src/server/services/task-registry.ts, src/server/services/task-registry.test.ts]
issue: 149
source: review
date: 2026-03-26
---
Same gap as F1: `TaskRegistryError` tests verified `instanceof` and `code` but not `e.name`. When the spec lists `this.name` as an explicit requirement, the constructor contract test must include a `name` assertion. Without it, deleting `this.name = 'TaskRegistryError'` is undetectable. Pattern: one dedicated constructor test per new typed error class asserting name, code, message, and instanceof Error.
