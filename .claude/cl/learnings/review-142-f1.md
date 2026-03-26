---
scope: [scope/services]
files: [src/server/services/bulk-operation.service.test.ts]
issue: 142
source: review
date: 2026-03-26
---
When a test helper is changed from silent fallthrough to throwing on timeout, the new throw behaviour must be exercised by a test that keeps the helper from completing. Simply adding `throw` without a test that proves the branch fires means the original silent-pass defect can regress unnoticed. Pattern: create a partial mock (e.g., `{ getJob: vi.fn().mockReturnValue({ status: 'running' }) } as unknown as BulkOperationService`) and pass it with a small `maxMs` to drive the helper through the timeout path, then assert `.rejects.toThrow(...)`.
