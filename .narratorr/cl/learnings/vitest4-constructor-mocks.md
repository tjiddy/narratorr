---
scope: [backend, core]
files: [src/server/services/metadata.service.test.ts, src/server/services/prowlarr-sync.service.test.ts]
issue: 329
date: 2026-03-10
---
Vitest 4 enforces that `vi.fn().mockImplementation()` used as constructors (called with `new`) must use `function()` syntax, not arrow functions. Arrow functions can't be `new`-ed in JS, and Vitest 4 stopped silently handling this. Fix: `mockImplementation(() => obj)` → `mockImplementation(function () { return obj; })`.
