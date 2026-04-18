---
scope: [backend, services]
files: [src/server/services/import.service.test.ts]
issue: 649
date: 2026-04-18
---
When removing a function from the codebase, all test files using the passthrough spy pattern (`vi.mock(..., async (importOriginal) => { const actual = ...; return { ...actual, funcName: vi.fn().mockImplementation(actual.funcName) }; })`) must have the spy entry removed from the mock factory AND the import removed. But also grep for the function name in assertion lines (`expect(funcName).toHaveBeenCalledWith(...)`) — the spec audit may miss assertions scattered across describe blocks far from the mock setup.
