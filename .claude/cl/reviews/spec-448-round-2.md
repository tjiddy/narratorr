---
skill: respond-to-spec-review
issue: 448
round: 2
date: 2026-03-18
fixed_findings: [F1, F2, F3]
---

### F1: Timestamp nullability mismatch
**What was caught:** Shared type defined refreshedAt and createdAt as string | null, but both are required strings in the client and non-null in the DB schema.
**Why I missed it:** When fixing F2 in round 1, I generalized all timestamp fields as nullable without reading the client interface field-by-field. I inferred nullability from the DB pattern (some timestamps are nullable) instead of copying the exact contract.
**Prompt fix:** Add to /respond-to-spec-review step 6 verification: "When defining shared types that replace existing contracts, verify every field type against the current consumer interface field-by-field. Do not infer nullability from DB schema patterns -- copy the exact types from the contract being replaced."

### F2: Missing compile-time enforcement
**What was caught:** Spec claimed typecheck would verify the shared type matches route output, but the route has no reference to the shared type -- typecheck cannot prove alignment.
**Why I missed it:** Assumed that defining a shared type is sufficient for compile-time safety. TypeScript only enforces types at assignment boundaries -- if no code on the server side references SuggestionRowResponse, it is just dead documentation.
**Prompt fix:** Add to /elaborate step 4 DRY-1 gap-fill: "For shared type introductions, the spec must name the compile-time enforcement mechanism: a typed mapper function, a satisfies assertion, or a return type annotation. Stating 'verified by typecheck' without an explicit linkage point is insufficient."

### F3: Stale call-site count
**What was caught:** "50+" was slightly stale (actual: 49). Minor but reinforces the round 1 lesson about exact measurements.
**Why I missed it:** Same root cause as round 1 F3 -- exact counts drift between clones. Already addressed by using qualitative language, but the headline "50+" slipped through.
**Prompt fix:** Already covered by round 1 retrospective. Applied consistently this round by removing the headline count.
