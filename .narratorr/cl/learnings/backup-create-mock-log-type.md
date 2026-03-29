---
scope: [backend]
files: [src/server/services/backup.service.test.ts]
issue: 200
date: 2026-03-29
---
`createMockLog()` in backup.service.test.ts returns `as never`, which prevents TypeScript from seeing `.warn`/`.info` properties. When writing tests that need to assert on log calls, cast through `unknown` first: `createMockLog() as unknown as { warn: ReturnType<typeof vi.fn>; [k: string]: unknown }` then pass `as never` to the constructor. The `applyPendingRestore` describe block already solved this with an inline typed `mockLog`.
