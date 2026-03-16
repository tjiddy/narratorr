---
scope: [scope/backend]
files: [src/server/services/notifier.service.test.ts, src/server/services/recycling-bin.service.test.ts]
issue: 393
source: spec-review
date: 2026-03-15
---
Elaboration found one duplicate DB-chain helper but missed two others (notifier, recycling-bin). The explore subagent searched for `mockDbChain` usage but didn't grep for the inline re-implementation pattern (local functions with the same method list + `.then` thenable). When scoping DRY cleanup, grep for the implementation pattern, not just the function name.
