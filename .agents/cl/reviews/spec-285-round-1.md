---
skill: respond-to-spec-review
issue: 285
round: 1
date: 2026-03-11
fixed_findings: [F1, F2, F3, F4, F5, F6, F7]
---

### F1: Settings category collision
**What was caught:** Spec assumed import lists could live in `settings.import`, which already stores post-download import behavior.
**Why I missed it:** /elaborate's subagent found the settings pattern but didn't read the actual contents of `settings.import` to check for conflicts. The test plan was built around a storage model that was never verified.
**Prompt fix:** Add to /elaborate step 3 subagent prompt: "For any settings category the spec references by name, READ the actual schema file and list current fields. Flag if the proposed usage conflicts with existing fields."

### F2: ABS API requires libraryId
**What was caught:** Spec collected URL+key but the referenced API endpoint requires a library ID never collected from the user.
**Why I missed it:** /elaborate copied the technical notes from the original spec without cross-referencing them against the user interactions. The contradiction was within the spec itself.
**Prompt fix:** Add to /elaborate step 2 parse completeness: "Cross-reference Technical Notes against User Interactions — if an API requires parameters not collected from the user, flag as incomplete."

### F3: Underspecified matching policy
**What was caught:** "Match against Audible metadata" is ambiguous — codebase has two different matching patterns.
**Why I missed it:** /elaborate's subagent explored the service interfaces but didn't read the full matching implementations to understand the behavioral differences between library-scan (first result) and match-job (confidence scoring).
**Prompt fix:** Add to /elaborate step 3 subagent deep source analysis: "When the spec references an operation like 'match' or 'enrich', find ALL implementations of that operation in the codebase and document their behavioral differences. The spec must pick one or define its own."

### F4: No storage for import source tag
**What was caught:** AC requires "Added via [list name]" tag but books table has no import-source column.
**Why I missed it:** /elaborate identified this as a defect vector (test scenario) but didn't promote it to a missing AC. The defect vector analysis found the gap but the gap-fill step didn't act on it.
**Prompt fix:** Add to /elaborate step 4 gap-fill: "For each DEFECT VECTOR that implies a missing DB column, API field, or type extension, check if a corresponding AC exists. If not, add it as a durable AC item."

### F5: Per-entity scheduling is a new pattern
**What was caught:** Current job system is fixed-task singletons, not per-DB-row scheduling. The spec didn't define which model to use.
**Why I missed it:** /elaborate's subagent noted the existing scheduling patterns but didn't flag that per-list intervals require a fundamentally different approach than existing jobs use.
**Prompt fix:** Add to /elaborate step 3 subagent: "When the spec requires scheduling per-entity (not per-task), check whether the current job infrastructure supports that pattern. If not, flag it as a design decision that must be specified in the AC."

### F6: No DB constraint backing dedup
**What was caught:** findDuplicate() is read-before-insert with no uniqueness constraint. Concurrent inserts can create duplicates.
**Why I missed it:** /elaborate identified the race condition as a defect vector and added test cases for it, but accepted the existing pattern as sufficient rather than questioning whether DB constraints were needed.
**Prompt fix:** Add to /elaborate step 3 subagent deep source analysis: "For any deduplication pattern the spec relies on, check whether it's backed by a DB uniqueness constraint. Application-level read-before-insert without a constraint is a known race — flag it as an AC gap requiring either a constraint or explicit acceptance of duplicates."

### F7: Preview endpoint in test plan but not AC
**What was caught:** Test plan included tests for a preview route not defined in ACs.
**Why I missed it:** /elaborate added the preview endpoint as a test case (testing something useful) without first promoting it to the AC. Test plans should only test committed surface area.
**Prompt fix:** Add to /elaborate step 4 gap-fill: "If the test plan includes test cases for endpoints, fields, or behaviors not present in the ACs, either promote them to ACs first or remove them from the test plan."
