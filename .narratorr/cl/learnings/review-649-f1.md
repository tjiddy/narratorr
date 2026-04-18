---
scope: [backend, services]
files: [src/server/services/import.service.test.ts]
issue: 649
source: review
date: 2026-04-18
---
When writing a regression test for removed behavior ("X no longer calls Y"), the test must mock Y and assert `expect(Y).not.toHaveBeenCalled()` — not just assert the operation succeeds. A success-only assertion is vacuous for a negative contract because the test would still pass if someone reintroduces the call. We removed the processAudioFiles mock during cleanup but needed to keep it specifically for the negative assertion.
