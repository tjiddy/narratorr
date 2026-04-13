---
scope: [backend]
files: [src/server/services/import-orchestrator.test.ts, src/server/services/import.service.test.ts]
issue: 541
date: 2026-04-13
---
When a test mocks a module but needs one function to behave realistically (e.g., `isContentFailure` with its pattern-matching logic), prefer `importOriginal()` passthrough with selective spy overrides over inlining a copy of the implementation. The passthrough pattern (`vi.mock('module', async (importOriginal) => { const actual = await importOriginal(); return { ...actual, specificFn: vi.fn() }; })`) keeps the real logic in sync automatically. The inline copy pattern silently drifts when the source changes.
