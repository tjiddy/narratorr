---
scope: [frontend]
files: [src/client/pages/activity/ActivityPage.test.tsx, src/client/pages/manual-import/ManualImportPage.test.tsx, src/client/lib/api/index.ts]
issue: 655
date: 2026-04-20
---
Two patterns coexist in this codebase for mocking `@/lib/api`: (a) hardcoded object-literal mocks listing each named export explicitly (brittle — breaks silently if a consumer imports a new export), and (b) `...actual` spread via `vi.importActual('@/lib/api')` (safe — inherits new barrel exports automatically). When adding a new barrel export like `formatBytesPerSec`, the hardcoded mocks only fail if a test fixture actively triggers the new consumer code path; otherwise the latency is dormant. Prefer spread-based mocks for new tests, and when adding a new shared util the safe default is to update the hardcoded mocks defensively even when existing tests still pass.
