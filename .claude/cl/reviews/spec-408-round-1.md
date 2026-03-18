---
skill: respond-to-spec-review
issue: 408
round: 1
date: 2026-03-17
fixed_findings: [F1, F2, F3, F4, F5, F6]
---

### F1: AC6 field references don't match actual model
**What was caught:** "reason tags" is vague — the model has singular `reason` enum + `reasonContext`, and the refresh overwrites both.
**Why I missed it:** AC was written against an assumed data model without verifying `src/db/schema.ts` and the update logic in `discovery.service.ts:103-107`.
**Prompt fix:** Add to `/spec` AC checklist: "For ACs that reference data fields, verify field names and types against `src/db/schema.ts` and the service methods that read/write them. Use exact field names, not paraphrases."

### F2: Partial failure contract undefined
**What was caught:** "Expiry failure shouldn't fail refresh" was stated in the test plan but never defined as a service contract.
**Why I missed it:** Error isolation was treated as a test concern rather than a design contract. The spec had no section for failure modes.
**Prompt fix:** Add to `/spec` template: "If the feature introduces error isolation (one sub-step failing shouldn't block others), add a 'Partial Failure Contract' section defining: what the method returns on partial failure, what the route returns, and what gets logged."

### F3: Snooze route missing success contract
**What was caught:** The snooze endpoint defined error cases but no success response (status code, body shape).
**Why I missed it:** Focused on validation/error paths and assumed the success path was obvious by analogy to dismiss.
**Prompt fix:** Add to `/spec` route AC template: "Every new route AC must specify: HTTP method, path, request body schema, success status code, and success response body shape. Do not define only error cases."

### F4: AC4 ambiguous about refresh pipeline
**What was caught:** "Re-score suggestions sharing author/series/genre" implied a new narrower algorithm when the existing full-refresh already handles this.
**Why I missed it:** Didn't check how `refreshSuggestions()` works before writing the AC. The AC described the desired outcome without anchoring it to the existing implementation.
**Prompt fix:** Add to `/spec` checklist: "For ACs that modify existing behavior, read the current implementation and state whether the AC requires new code or is satisfied by existing behavior. If satisfied by existing behavior, the AC should say so explicitly and define only what the acceptance test asserts."

### F5: Concurrency requirement too weak
**What was caught:** Filtering the initial read by `status = 'pending'` doesn't protect against race conditions — the DELETE itself needs the predicate.
**Why I missed it:** Framed the concurrency requirement at the query level instead of the mutation level. Didn't examine the existing stale-delete pattern that has the same anti-pattern.
**Prompt fix:** Add to `/spec` concurrency checklist: "For race-safety requirements, specify the predicate on the mutating statement (DELETE/UPDATE), not just the preceding read. Frame as: 'the DELETE/UPDATE must include WHERE <condition> to be atomic with respect to concurrent status changes.'"

### F6: Blast radius understated
**What was caught:** Missing client settings form, API types, and job tests from the blast radius.
**Why I missed it:** Grepped for direct references but didn't trace the full dependency chain (schema → registry → UI form, schema → DB → service → route → API types → client).
**Prompt fix:** Add to `/spec` blast radius checklist: "Trace the full dependency chain for schema changes: schema → settings registry → settings UI form → settings UI tests, and schema → DB → service → route → API type layer → client API tests."