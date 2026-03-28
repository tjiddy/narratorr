---
scope: [frontend]
files: [src/client/pages/settings/SecuritySettings.test.tsx]
issue: 11
date: 2026-03-19
---
In jsdom (vitest client environment), `navigator.clipboard` is `undefined` with no own or prototype descriptor. BUT as soon as any test in a file calls `userEvent.setup()`, the user-event library installs a persistent clipboard stub for the entire file via a global `afterEach` that only resets (not removes) the stub. Subsequent tests in that file see `navigator.clipboard` as the stub object with an async `writeText` method — confusingly different from a fresh jsdom context.
