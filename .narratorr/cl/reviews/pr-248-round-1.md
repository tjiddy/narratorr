---
skill: respond-to-pr-review
issue: 248
pr: 252
round: 1
date: 2026-03-31
fixed_findings: [F1, F2, F3, F4, F5]
---

### F1: BlacklistService.create() missing at-least-one-identifier guard
**What was caught:** Service layer allowed inserting blacklist rows with both identifiers absent.
**Why I missed it:** Focused on schema-level validation (superRefine) but didn't consider internal callers that bypass Zod schemas.
**Prompt fix:** Add to `/implement` step 4: "When relaxing a NOT NULL constraint, add service-level validation matching the schema constraint — internal callers bypass Zod."

### F2: Fallback deletion bypasses ancestry guard on lookup failure
**What was caught:** catch block after getById logged but fell through to rm(), bypassing the safety check.
**Why I missed it:** The catch block followed the fire-and-forget pattern used elsewhere (log and continue), but in this context "continue" means "delete without safety check."
**Prompt fix:** Add to `/implement` step 4: "In catch blocks guarding safety-critical operations (file deletion, auth checks), the failure path must be conservative (skip the operation), not permissive (proceed without the guard)."

### F3: getBlacklistedIdentifiers query path untested at service level
**What was caught:** All caller tests stubbed the method. No test verified the actual query predicate.
**Why I missed it:** Coverage review identified it as a gap but the fix agent only added stub-level assertions.
**Prompt fix:** Add to coverage review prompt: "For new service methods, verify at least one test calls the REAL method (not a stub) and asserts the query predicate/arguments."

### F4: DownloadClientFields downloadRoot untested
**What was caught:** New form field with no component test.
**Why I missed it:** Focused on backend logic; frontend field was treated as trivial.
**Prompt fix:** Add to `/implement` step 4: "Every new form field needs a component test asserting: label present, input accepts value, field registered with correct name."

### F5: downloadRoot schema parse coverage missing
**What was caught:** No safeParse test for the new schema field.
**Why I missed it:** Same as F4 — treated as trivial optional field.
**Prompt fix:** Add to `/implement` step 4: "Every new schema field needs at least one safeParse test — even optional fields can break superRefine or required-field rules."
