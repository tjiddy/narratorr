---
scope: [scope/backend]
files: [src/server/jobs/search.test.ts, src/server/jobs/rss.test.ts, src/server/services/backup.service.test.ts, src/server/services/import.service.test.ts, src/server/services/recycling-bin.service.test.ts, src/server/services/tagging.service.test.ts]
issue: 392
source: spec-review
date: 2026-03-15
---
Reviewer caught that the spec didn't address how server-side `createMockSettingsService()` wrappers should consume the new factory. These wrappers hardcode category-level literals and would continue drifting even after client-side migration. Root cause: the spec treated "settings fixtures" as a single pattern but the server tests use a different mock shape (service wrapper with `.get()` stubs) than client tests (raw `AppSettings` objects). Prevention: when migrating a pattern, identify all variant shapes of that pattern, not just the most common one.
