---
scope: [backend]
files: [src/server/services/import.service.test.ts]
issue: 274
date: 2026-04-01
---
`vi.clearAllMocks()` in `setupDefaults` resets module-level `statfs` mock implementation, causing `checkDiskSpace` to throw "Cannot read properties of undefined (reading 'bavail')". New describe blocks using `setupDefaults` must re-mock `statfs` in their own `beforeEach`.
