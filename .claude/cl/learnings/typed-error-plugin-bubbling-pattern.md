---
scope: [backend, services, api]
files: [src/server/plugins/error-handler.ts, src/server/services/download.service.ts, src/server/services/task-registry.ts]
issue: 149
date: 2026-03-26
---
The codebase error pattern: define a service-specific class extending `Error` with a `code` field and `this.name` assignment (see `MergeError`, `RenameError`), register in `error-handler.ts` `ERROR_REGISTRY` Map, remove route-local try/catch. Routes don't keep any `instanceof` catches — all typed errors bubble to the global plugin. This eliminates `message.includes(...)` string matching and makes error routing explicit and type-safe.
