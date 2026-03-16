---
scope: [backend]
files: [src/server/jobs/monitor.test.ts, src/server/services/download.service.test.ts]
issue: 392
date: 2026-03-15
---
When migrating inline `{ get: vi.fn() }` mocks to a typed `createMockSettingsService()` that returns `SettingsService`, any type annotations in the test that declared the field as `{ get: ReturnType<typeof vi.fn> }` will fail TypeScript because `SettingsService` is not assignable to a `Mock`-typed interface. Fix by updating the type annotation to `ReturnType<typeof createMockSettingsService>`.
