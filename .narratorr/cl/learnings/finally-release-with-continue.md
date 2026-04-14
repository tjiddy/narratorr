---
scope: [backend]
files: [src/server/services/import-orchestrator.ts]
issue: 539
date: 2026-04-13
---
In a `while`/`try`/`finally` loop, `continue` inside `try` still executes the `finally` block before the next iteration. This makes `finally { releaseSlot() }` reliable for both the CAS-miss `continue` path and the normal import completion path — one release per acquired slot without duplication. Avoids the common mistake of releasing in both `if (!claimed)` and `finally`.
