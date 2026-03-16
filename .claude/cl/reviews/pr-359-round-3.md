---
skill: respond-to-pr-review
issue: 359
pr: 378
round: 3
date: 2026-03-15
fixed_findings: [F1]
---

### F1: Local schema override backs out the L-19 refactor
**What was caught:** Restoring a local `idParamSchema` in recycling-bin.ts preserved behavior but violated the L-19 AC which requires using the shared schema.
**Why I missed it:** When the round 2 reviewer flagged the validation gap, I fixed it by restoring the local schema rather than asking "can I tighten the shared schema to satisfy both requirements?" The AC said "import shared schema" but I chose to keep a local override instead of fixing the shared schema to be correct.
**Prompt fix:** Add to `/respond-to-pr-review` step 3 (sibling pattern check): "When a finding requires tightening validation, check whether the shared schema should be tightened for all consumers rather than adding a local override. If the tighter contract is correct for all callers (e.g., all DB IDs are positive), fix the shared schema."
