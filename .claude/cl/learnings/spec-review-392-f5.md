---
scope: [scope/backend]
files: [src/server/services/blacklist.service.test.ts, src/server/jobs/housekeeping.test.ts, src/server/services/event-history.service.test.ts, src/server/services/download.service.test.ts, src/server/jobs/monitor.test.ts, src/server/services/indexer.service.test.ts, src/server/routes/system.test.ts]
issue: 392
source: spec-review
date: 2026-03-15
---
Reviewer caught that AC4/AC5 verification only covered two of three settings mock patterns (factory callsites and wrapper helpers), missing direct inline `settingsService.get.mockResolvedValue({...})` mocks with hardcoded category literals. Root cause: the grep sweep in /elaborate only searched for `createMockSettings(` and `createMockSettingsService()` — it didn't search for the third pattern where tests construct `{ get: vi.fn().mockResolvedValue({...}) }` inline without a wrapper function. Prevention: when identifying migration targets for a pattern replacement, enumerate ALL variant shapes of the pattern (factory calls, wrapper functions, AND inline constructions) and grep for each separately.
