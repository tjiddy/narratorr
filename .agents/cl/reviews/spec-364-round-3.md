---
skill: respond-to-spec-review
issue: 364
round: 3
date: 2026-03-14
fixed_findings: [F1]
---

### F1: Index tie-breaker is order-dependent for exact duplicates
**What was caught:** The round 2 fix added "always append array index as tie-breaker" but index is order-dependent — the same problem the issue exists to fix. SearchResult has `downloadUrl`/`detailsUrl` as order-independent differentiators that should be preferred.
**Why I missed it:** Treated index as a universal fallback without re-reading the type definitions to check for better order-independent fields. The round 2 fix focused on "how to make keys unique" but not "how to make keys stable under reorder."
**Prompt fix:** Add to `/elaborate` step 4 test plan gap-fill: "When defining React key contracts, read every field on the type interface and classify each as order-independent (stable across reorders) or order-dependent (changes with array position). Prefer order-independent fields exhaustively before allowing index. If index is used, explicitly justify why no order-independent alternative exists."
