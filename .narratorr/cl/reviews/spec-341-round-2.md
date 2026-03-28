---
skill: respond-to-spec-review
issue: 341
round: 2
date: 2026-03-11
fixed_findings: [F6, F7]
---

### F6: Backend category-level upsert behavior not accounted for
**What was caught:** `SettingsService.set()` replaces the entire category value, so partial `general` payloads would clobber sibling fields.
**Why I missed it:** Round 1 correctly identified that the API accepts partial category payloads (`UpdateSettingsInput`), but I didn't trace the storage path through `set()` to see that it upserts the whole category without field-level merge. I verified the API contract but not the storage semantics.
**Prompt fix:** Add to `/elaborate` step 3 (Explore subagent) deep source analysis: "For any backend service that stores data, trace the full write path from route handler → service method → DB operation. Verify whether the storage operation merges at the entity level, category level, or field level. Document the merge granularity in the spec."

### F7: Unresolved shared-category ownership between Housekeeping and Logging
**What was caught:** AC said "each subsection has its own useForm" while technical notes deferred the Housekeeping/Logging decision to implementation.
**Why I missed it:** I recognized the shared `general.*` category problem in the round 1 test plan ("implementation must decide") but didn't treat it as a spec-level decision that needed resolution. Deferring design choices to implementation creates ambiguous AC.
**Prompt fix:** Add to `/elaborate` step 4 (Fill gaps): "If the spec maps multiple UI sections to the same backend storage unit (DB table, category key, config namespace), the spec MUST resolve the ownership — either combine the sections, define a merge strategy, or scope a backend change. Do not defer to implementation."
