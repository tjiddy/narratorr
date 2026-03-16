---
scope: [backend]
files: [src/server/services/import.service.test.ts]
issue: 392
source: review
date: 2026-03-15
---
Reviewer caught 5 more inline settings mocks in import.service.test.ts that were missed during the migration. These were in the tagging integration and post-processing script test sections — added later than the original import service tests and using a different inline `inject<SettingsService>({...})` pattern rather than the local `createMockSettingsService()` wrapper. The earlier migration only replaced the local wrapper and its callers, not these separate inline constructions deeper in the file. Prevention: after migration, do a final grep for `inject<SettingsService>` + `mockImplementation` across the ENTIRE file, not just the known wrapper callsites.
