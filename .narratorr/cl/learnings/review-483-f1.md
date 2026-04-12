---
scope: [backend]
files: [src/server/utils/safe-emit.ts, src/server/utils/safe-emit.test.ts]
issue: 483
source: review
date: 2026-04-12
---
When a function uses a generic constraint (like `T extends SSEEventType`), runtime tests alone don't prove the constraint works — a widening to `string` would still pass all tests. Add a `@ts-expect-error` compile-time test proving invalid values are rejected. The spec's test plan explicitly called for this ("Generic constraint enforces SSEEventType keys") but implementation only covered runtime paths. Check test plans for type-safety items and implement them as `@ts-expect-error` assertions.
