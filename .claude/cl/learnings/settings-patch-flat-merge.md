---
scope: [backend, services]
files: [src/server/services/settings.service.ts]
issue: 411
date: 2026-03-16
---
When adding a method to a service that has a mock factory in test helpers, the mock factory must be updated in the same commit — otherwise all 19+ test files that use `createMockSettingsService()` could break if they call the new method. The blast radius for service API changes extends to the mock factory, not just direct callers.
