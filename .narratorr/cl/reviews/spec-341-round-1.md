---
skill: respond-to-spec-review
issue: 341
round: 1
date: 2026-03-11
fixed_findings: [F1, F2, F3, F4, F5]
---

### F1: Full-object merge vs partial category payloads
**What was caught:** Spec required full settings object saves with cache merging, but the API already supports partial per-category payloads.
**Why I missed it:** The elaborate step read BackupScheduleForm (which uses partial payloads) but the original spec body predated that exploration and was never reconciled. The elaborate step added test plan items but didn't re-examine the System Behaviors section for accuracy against the actual API types.
**Prompt fix:** Add to `/elaborate` step 3 (Explore subagent): "For any API endpoint the spec references, verify the request type signature and route validation schema. If the spec describes a different payload shape than what the API accepts, flag this as a durable fix to the spec body."

### F2: Concurrent save conflict under full-payload design
**What was caught:** Full-payload saves from multiple sections would overwrite each other's unrelated categories.
**Why I missed it:** This was a direct consequence of F1 — the wrong API contract made the concurrency claim ("sections don't overlap") false. Once F1 was wrong, F2 was inevitable.
**Prompt fix:** Same as F1 — verifying the actual API contract would have prevented both.

### F3: Cross-category field ownership (RSS in Search, tagging in Processing)
**What was caught:** Spec treated each section as owning a single settings category, but SearchSettingsSection registers `rss.*` fields and ProcessingSettingsSection registers `tagging.*` fields.
**Why I missed it:** The elaborate step listed section components but didn't grep for which `register()` field prefixes each component uses. It assumed section name = category name.
**Prompt fix:** Add to `/elaborate` step 3 (Explore subagent): "For form refactoring issues, grep each section component for `register('` calls and map which settings categories each component owns. Flag any section that owns multiple categories."

### F4: Contradictory cache invalidation behavior
**What was caught:** "All sections reset to fresh server state" contradicts "unsaved changes are preserved."
**Why I missed it:** System Behaviors bullets were written independently — one described the cache invalidation trigger, another described dirty state preservation — without cross-checking for contradictions.
**Prompt fix:** Add to `/elaborate` step 2 (Parse spec completeness): "Scan System Behaviors for pairs of statements that describe the same trigger event with conflicting outcomes. Flag any contradiction as a durable fix."

### F5: Missing blast radius test file enumeration
**What was caught:** Spec didn't list the specific test files that would need updates.
**Why I missed it:** The elaborate step's explore subagent found the settings blast radius pattern from workflow history but didn't translate it into a concrete file list in the spec body.
**Prompt fix:** Add to `/elaborate` step 4 (Fill gaps): "For refactoring issues, glob for `*.test.ts*` in the target directory and add a 'Blast radius — affected test files' section listing files whose test setup depends on the architecture being changed."
