---
scope: [backend, services]
files: [src/server/services/retry-search.test.ts, src/server/services/download-orchestrator.test.ts]
issue: 57
source: review
date: 2026-03-22
---
When adding a required field to a shared type (DownloadWithBook), grep ALL test files for typed declarations of that type — not just the test file for the changed service. Typed declarations without `as TypeName` cast will fail typecheck; declarations with `as TypeName` cast will survive. The distinction matters: retry-search.test.ts used a plain typed declaration and needed the fix; download-orchestrator.test.ts used an `as` cast and was safe. Blast radius check: `grep -rn "TypeName = {" src/ --include="*.test.ts" | grep -v "as TypeName"` finds all strict-typed fixtures.
