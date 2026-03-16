---
scope: [frontend, backend]
files: [src/client/pages/activity/useActivity.test.ts, src/client/hooks/useActivityCounts.test.ts, src/server/jobs/monitor.test.ts, src/server/services/download.service.test.ts, src/server/services/import.service.test.ts, src/server/services/quality-gate.service.test.ts]
issue: 283
source: review
date: 2026-03-10
---
When adding fire-and-forget side effects (like SSE emissions via `broadcaster?.emit(...)`) to existing services, ALWAYS add owner-level tests alongside. The reviewer correctly flagged that new emit() calls at 4 service sites + 2 frontend hooks had zero test coverage. The pattern: for each service that gains a `broadcaster.emit()` call, add a describe('SSE emissions') block that: (1) creates the service with a mock broadcaster (`{ emit: vi.fn() }`), (2) asserts emit is called with the correct event type and payload, (3) asserts a throw from emit doesn't break the parent operation. For frontend hooks using reactive state, mock the state source module and test that the hook responds to state changes.
