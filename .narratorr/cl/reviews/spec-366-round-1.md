---
skill: respond-to-spec-review
issue: 366
round: 1
date: 2026-03-16
fixed_findings: [F1, F2, F3, F4, F5, F6, F7]
---

### F1: Language field doesn't exist in schema
**What was caught:** Spec relied on "dominant library language" for filtering/scoring but `books` table has no `language` column.
**Why I missed it:** The `/elaborate` subagent read the schema but focused on field presence for signals (genres, series, narrator) without verifying that the *algorithm design* section's assumptions also mapped to schema columns. Language was inherited from the original spec without validation.
**Prompt fix:** Add to `/elaborate` step 3 subagent prompt: "For every field referenced in the Algorithm Design or Scoring sections, verify it exists as a persisted column in `src/db/schema.ts` or identify the alternative data source. Flag any field that requires schema additions or alternative derivation."

### F2: Global MAX_RESULTS change affects all callers
**What was caught:** Spec said "increase MAX_RESULTS" but it's a global constant affecting all metadata searches.
**Why I missed it:** The elaborate step identified this as a "defect vector" but didn't promote it to a spec-level design fix. Defect vectors feed the test plan but should also feed back into the implementation section when they reveal design issues.
**Prompt fix:** Add to `/elaborate` step 4 gap-fill: "Review DEFECT VECTORS from step 3. Any vector that reveals a shared constant/interface modification should be escalated to the Implementation section as a design concern, not just noted as a test scenario."

### F3: Rate limit contract mismatch
**What was caught:** Spec required throttle backoff but named methods that swallow throttle into empty results.
**Why I missed it:** Same pattern as F2 — identified as defect vector but not escalated. The elaborate step traced the throttle pattern but didn't connect "AC7 says detect throttle" to "which methods actually surface throttle state."
**Prompt fix:** Add to `/elaborate` step 3 subagent prompt under deep source analysis: "For each AC that references error handling or rate limiting, trace which specific method the implementation will call and verify that method's return type includes the required signal (e.g., warnings array, error type). If the named method swallows the signal, flag as a spec gap."

### F4: Stale suggestion lifecycle undefined
**What was caught:** Test plan said "either kept or cleaned up (define behavior)" — a placeholder, not a decision.
**Why I missed it:** The elaborate step added a test plan item that flagged the ambiguity but left it unresolved. This is a gap in the gap-fill process itself — "define behavior" placeholders are not durable content.
**Prompt fix:** Add to `/elaborate` step 4 gap-fill: "Test plan items must not contain 'define behavior', 'TBD', or 'either X or Y' placeholders. If a behavior is ambiguous, choose the simpler default (e.g., delete stale rows, return 409 for duplicates) and state it as the spec's decision. The reviewer or implementer can override, but the spec must have a concrete answer."

### F5: Add-route duplicate/already-added behavior undefined
**What was caught:** Same placeholder pattern as F4, plus spec assumed duplicate check lives in BookService.create() when it's in the route layer.
**Why I missed it:** The elaborate subagent traced BookService.create() and noted the author upsert race condition but didn't trace the duplicate detection flow. The "add suggestion" path was treated as a simple "call create()" without verifying where each safety check lives.
**Prompt fix:** Add to `/elaborate` step 3 subagent prompt: "For each route that creates or modifies entities, trace where validation/duplicate/auth checks happen (route layer vs service layer) and note which checks the new route must replicate vs which are inherited."

### F6: Issue comment requirement not in spec body
**What was caught:** Comment 7071 added a nav visibility toggle requirement that never made it into the spec body.
**Why I missed it:** The `/elaborate` step reads comments to check for spec review findings but doesn't integrate non-review comments into the spec body. Comment 7071 was a requirements addition, not a review finding.
**Prompt fix:** Add to `/elaborate` step 1 after reading comments: "Scan all comments (not just spec review comments) for additional requirements, scope changes, or constraints. If found, integrate them into the relevant spec section (AC, settings, scope boundaries) during step 4 gap-fill."
