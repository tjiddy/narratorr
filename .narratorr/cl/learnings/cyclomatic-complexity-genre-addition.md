---
scope: [backend]
files: [src/server/services/library-scan.service.ts]
issue: 350
date: 2026-04-04
---
`applyAudnexusEnrichment` was already at complexity 15 before adding genre logic. Adding a single `if` with `&&` pushed it to 16. The fix was extracting `applyEnrichmentData()` as a private method. When planning changes to methods near the complexity limit, budget for extraction upfront rather than discovering it at lint time.
