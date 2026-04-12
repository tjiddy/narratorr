---
scope: [backend]
files: [src/server/services/import-list.service.ts, src/server/jobs/enrichment.ts]
issue: 482
source: review
date: 2026-04-12
---
When adding a try/catch for error isolation, the catch scope must be surgically narrow — wrap ONLY the call that's expected to throw, not subsequent operations. Wrapping both `findOrCreate` and the junction `insert` in the same try silently swallows unrelated DB failures. Use a `let id; try { id = await helper(); } catch { ... } if (id) { await insert(); }` pattern instead.
