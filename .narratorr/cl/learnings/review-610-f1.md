---
scope: [frontend]
files: [src/client/hooks/useCrudSettings.test.ts]
issue: 610
source: review
date: 2026-04-16
---
Mock-only assertions (checking a spy was called) are insufficient when the spec requires proving a real state transition. When `useConnectionTest` is fully mocked, asserting `mockClearFormTestResult.toHaveBeenCalledOnce()` only proves delegation, not that `formTestResult` actually becomes `null`. Use `vi.importActual()` to restore the real hook in integration-style tests and assert on observable state (`result.current.tests.formTestResult`). This gap would have been caught by applying the test quality standard "assert consequences, not implementation" more strictly — the consequence is `formTestResult === null`, not `clearFormTestResult was called`.
