---
scope: [backend]
files: [src/server/services/import.service.ts]
issue: 318
source: review
date: 2026-04-03
---
Reviewer caught that `cleanupDeferredImports()` cleared `pendingCleanup` even when `adapter` was null — abandoning the retry loop without removing the torrent. The self-review caught a weaker version of this bug (the `adapter!` assertion), but the fix still had a logic gap where null adapter fell through to the DB clear. Root cause: the `if (adapter) { ... }` block was followed by an unconditional `pendingCleanup: null` update. Fix: make the DB clear conditional on successful removal by returning early when adapter is missing.
