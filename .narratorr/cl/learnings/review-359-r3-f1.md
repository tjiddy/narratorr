---
scope: [backend]
files: [src/shared/schemas/common.ts, src/server/routes/recycling-bin.ts]
issue: 359
source: review
date: 2026-03-15
---
When a local schema is stricter than the shared one, the right fix is to tighten the shared schema rather than keeping a local override — IF the tighter contract is correct for all consumers. The shared `idParamSchema` should reject zero/negatives because all DB IDs are auto-increment positive integers. Keeping a local override would satisfy the behavior but violate the L-19 AC to use the shared schema. The reviewer caught that restoring a local schema backed out the refactor rather than completing it.
