---
scope: [frontend]
files: [src/client/hooks/useBulkOperation.ts, src/client/hooks/useBulkOperation.test.ts]
issue: 147
date: 2026-03-27
---
When a module is fully mocked with `vi.mock('@/lib/api', () => ({ api: {...} }))`, class imports like `ApiError` are `undefined` in the mocked context — so `instanceof ApiError` in the production code silently fails at test time. Either add the class to the mock factory, or use a structural check (`instanceof Error && (error as { status?: number }).status`) instead of a class identity check. The structural check also avoids coupling the hook to a specific error class.
