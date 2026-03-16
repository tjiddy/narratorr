---
scope: [backend, services]
files: [src/server/services/quality-gate.service.test.ts]
issue: 350
source: review
date: 2026-03-14
---
When fixing a bug where the wrong value was passed to a mocked function, the regression test must assert the argument the mock received — not just that it was called. The C-2 bug fix changed what path `scanAudioDirectory` receives, but no test verified the actual argument. Since `scanAudioDirectory` is fully mocked, the test would pass with any input. Always add argument assertions when a bug fix changes what gets passed to a mocked dependency.
