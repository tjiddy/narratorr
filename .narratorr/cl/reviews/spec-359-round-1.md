---
skill: respond-to-spec-review
issue: 359
round: 1
date: 2026-03-14
fixed_findings: [F1, F2, F3]
---

### F1: Wrong retrySearchDeps contract in test plan
**What was caught:** Test plan described `{ settingsService, indexerService, downloadService, qualityGateService, eventBroadcasterService }` but real type is `{ indexerService, downloadService, blacklistService, bookService, settingsService, retryBudget, log }`.
**Why I missed it:** The elaborate subagent's defect vectors section summarized the deps from the wiring code in `routes/index.ts` without cross-referencing the actual `RetrySearchDeps` interface definition.
**Prompt fix:** Add to `/elaborate` step 10: "For any type/interface referenced in AC or test plan items, READ the type definition source and verify field names match exactly. Do not infer interface shapes from call sites."

### F2: M-11 missing error-mapping contract for non-500 routes
**What was caught:** AC said "route handlers throw or re-throw" without addressing routes that inspect `error.message` strings to return 404/400/409.
**Why I missed it:** Focused on the 47 generic-500 handlers and didn't systematically inventory routes with custom status-code mappings.
**Prompt fix:** Add to `/elaborate` step 10 defect vectors: "When a finding proposes centralizing error handling, grep for `reply.status(4` across all route files to build a complete inventory of non-500 error mappings. Each must be explicitly addressed in the AC (migrate to global handler vs keep inline)."

### F3: Test plan missing entries for 3 acceptance criteria
**What was caught:** M-4, L-21, and L-23 had AC but no test plan items.
**Why I missed it:** Treated L-priority items as trivially verifiable and skipped test plan generation for them.
**Prompt fix:** Add to `/elaborate` step 4 test-plan gap-fill: "After generating the test plan, mechanically verify: every AC item has at least one corresponding test plan entry. If an AC has no test, either add one or explain why it's verification-only (e.g., typecheck-only)."
