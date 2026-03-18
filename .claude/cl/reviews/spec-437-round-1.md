---
skill: respond-to-spec-review
issue: 437
round: 1
date: 2026-03-18
fixed_findings: [F1, F2, F3, F4, F5, F6, F7]
---

### F1: Metadata registry design underspecified
**What was caught:** AC didn't define how the Audible search vs Audnexus enrichment split should be preserved in the registry.
**Why I missed it:** Didn't read the full MetadataService source to understand the providers[] vs audnexus architectural split. Wrote a generic "factory registry" AC without understanding the two-role provider model.
**Prompt fix:** Add to /elaborate step 3 exploration prompt: "For registry/factory refactors, identify all distinct roles the current code assigns to instances of the target type (e.g., user-visible vs hidden, search vs enrichment). The spec must define which roles the registry covers and which remain hardcoded."

### F2: Route import AC broader than scope
**What was caught:** "No remaining direct imports from src/core/ in any route file" was impossible to satisfy — other routes also import from src/core/.
**Why I missed it:** Wrote the grep-based test without actually running the grep to verify it would pass after the scoped fix.
**Prompt fix:** Add to /elaborate step 4 test plan gap-fill: "For greppable AC (no remaining X in Y), run the grep now and enumerate all current matches. If the AC scope doesn't cover all matches, narrow the grep target or expand the scope."

### F3: CRUD section stale
**What was caught:** CrudSettingsPage already exists and DownloadClientsSettings already uses it, but spec described all three as needing extraction.
**Why I missed it:** Spec was written from an outdated mental model. The /elaborate subagent did find this (it's in the codebase findings), but the gap-fill step didn't use the finding to correct the problem statement.
**Prompt fix:** Add to /elaborate step 4: "Cross-reference subagent's SIMILAR FEATURES findings against the problem statement. If the problem statement describes work that's already done, rewrite the section to reflect remaining scope only."

### F4: Timeout constants under-enumerated
**What was caught:** Only named 2 of 7+ hardcoded timeout locations, didn't note constants.ts already exists, claimed uniform 15s when values are 10/15/30s.
**Why I missed it:** Took the original spec's claim at face value instead of verifying with a codebase grep.
**Prompt fix:** Add to /elaborate step 3 exploration: "For constant-extraction refactors, grep all instances of the target constant/value pattern across the codebase. Report exact values, file locations, and which ones are already centralized."
