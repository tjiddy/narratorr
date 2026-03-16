---
scope: [core]
files: [src/core/notifiers/script.ts, src/core/notifiers/script.test.ts]
issue: 382
date: 2026-03-15
---
When changing `exec` → `execFile`, every existing test mock must also change — the mock factory, import, and all `mockImplementation` calls. Since `execFile` has a different overload signature, use `(...args: unknown[]) => void` for callback casts (per the `execfile-callback-type-lint` learning). The migration is all-or-nothing: if even one test still mocks `exec`, it'll pass vacuously because the real code now calls `execFile` which is unmocked.
