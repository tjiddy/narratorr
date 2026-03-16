---
scope: [backend]
files: [src/server/routes/system.test.ts, src/server/routes/books.test.ts, src/server/routes/search.test.ts, src/server/services/health-check.service.test.ts]
issue: 392
source: review
date: 2026-03-15
---
Reviewer caught that the fixture migration sweep was incomplete — 4 additional server files (system.test.ts, books.test.ts, search.test.ts, health-check.service.test.ts) still hardcoded category-level settings literals. The blast radius inventory from the spec review only covered files with `createMockSettingsService()` wrappers and direct inline mocks, but missed route tests that use `services.settings.get` via the proxy-based `createMockServices()` pattern. Prevention: when migrating a pattern, grep for ALL callsites of the underlying method (`settings.get`), not just the named wrapper patterns.
