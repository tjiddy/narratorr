---
skill: respond-to-spec-review
issue: 448
round: 1
date: 2026-03-18
fixed_findings: [F1, F2, F3, F4]
---

### F1: Stale debt.md references in ACs
**What was caught:** ACs required striking through debt.md entries that no longer existed in the current file.
**Why I missed it:** The /elaborate skill wrote ACs referencing debt.md internal state at elaboration time without considering the file changes independently. The debt log was cleared between issue creation and spec review.
**Prompt fix:** Add to /elaborate step 4 gap-fill: "Never write ACs that reference the internal state of tracking artifacts (debt.md, workflow-log.md). These files change independently of the issue. Write ACs in terms of work outcomes ('items closed with rationale') not artifact mutations ('strike through in debt.md')."

### F2: SuggestionRow shared contract undefined
**What was caught:** Spec said "derive from shared schema" but the shared artifact does not exist, and the spec did not define it or the serialization boundary (DB Date vs API ISO string).
**Why I missed it:** The /elaborate skill detected DRY-1 (parallel types) but only prescribed the direction ("derive from shared") without defining the solution contract: what artifact to create, what it models, and how consumers migrate.
**Prompt fix:** Add to /elaborate step 4 gap-fill: "For DRY-1 findings (type duplication), the spec must define: (1) the new shared artifact name and location, (2) which layer it models (DB row, API response, or wire format), (3) how each consumer (server and client) migrates to it. 'Derive from shared' without these details is insufficient."

### F3: Exact line count becomes stale
**What was caught:** Spec cited 518 lines but reviewer saw 459 on a different clone.
**Why I missed it:** Used an exact measurement that drifts as PRs merge on different clones. The relevant fact is the ESLint constraint violation, not the specific count.
**Prompt fix:** Add to /elaborate general guidance: "Reference constraint violations (e.g., 'exceeds 400-line ESLint limit with eslint-disable suppression') rather than exact measurements that drift between clones."

### F4: Catch-block removal loses logging context
**What was caught:** sendInternalError removal plan only addressed response shape, not the route-local logging context each catch block provides.
**Why I missed it:** Blast radius analysis focused on call site counts and response shapes but did not audit non-response side effects in catch blocks (logging, cleanup, metrics).
**Prompt fix:** Add to /elaborate blast radius analysis: "When a refactor removes catch blocks, audit each block for non-response side effects (logging context, cleanup, metrics). Document whether each side effect must be preserved, migrated, or is intentionally dropped."
