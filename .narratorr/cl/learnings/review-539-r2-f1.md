---
scope: [backend]
files: [src/server/services/import.service.ts]
issue: 539
source: review
date: 2026-04-14
---
When fixing a review finding by changing behavior (e.g., return false → throw), verify the new behavior still satisfies ALL original ACs — not just the one the finding addressed. Here the fix for infinite retry (throw instead of return false) dropped the warning log that was an explicit AC. Both behaviors can coexist: log the warning for observability, then throw for correctness.
