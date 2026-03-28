---
scope: [backend, core]
files: [src/server/services/indexer.service.test.ts, src/server/services/download-client.service.test.ts, src/core/indexers/abb.test.ts]
issue: 329
date: 2026-03-10
---
Vitest 4 broke `vi.spyOn(obj as never, 'method')` — the `as never` cast causes the return type to be `never`, making `.mockReturnValue()` fail. Tried `as unknown as Record<string, unknown>` and `as never as { method: unknown }` — both failed. Only fix: `as any` with `// eslint-disable-next-line @typescript-eslint/no-explicit-any`. This pattern appears when spying on private/protected methods in tests.
