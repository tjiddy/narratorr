---
scope: [backend]
files: [src/server/services/discovery.service.test.ts]
issue: 524
date: 2026-04-13
---
`describe.skip()` blocks are still type-checked by TypeScript — skipping only prevents runtime execution, not compilation. When removing a method that tests reference, you must delete or fully rewrite the test block, not just skip it. Using `describe.skip` with references to deleted methods causes typecheck failures.
