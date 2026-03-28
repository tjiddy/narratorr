---
skill: respond-to-spec-review
issue: 392
round: 1
date: 2026-03-15
fixed_findings: [F1, F2, F3, F4]
---

### F1: AC2 lists wrong settings categories
**What was caught:** AC2 said "general, library, search, import, quality, network, processing, notifications" but the real registry has 11 categories including `metadata`, `tagging`, `rss`, `system` and no `notifications`.
**Why I missed it:** The `/elaborate` skill's subagent correctly identified the 11 categories and noted the mismatch in ephemeral findings, but the original spec text was never corrected. The gap-fill step focused on test plan and blast radius, not on verifying existing AC text against codebase facts.
**Prompt fix:** Add to `/elaborate` step 4 (Fill gaps): "Cross-check every enumerated list in existing AC items (category names, adapter types, field lists) against the authoritative source. If the spec enumerates a contract surface, verify it matches the codebase — don't just note the discrepancy in ephemeral findings."

### F2: Stale fixture blast radius inventory
**What was caught:** The fixed "13/13" file count was already stale and didn't include quantified callsite counts.
**Why I missed it:** The blast radius section was generated from a single-pass grep but presented as a static list without verification criteria. AC4 said "all existing test files" but the inventory was a snapshot, not a query.
**Prompt fix:** Add to `/elaborate` step 4: "When AC requires 'all X are migrated/updated', define verification as a grep pattern or command, not a fixed file list. Static inventories go stale between spec-writing and implementation."

### F3: DeepPartial referenced as if it exists
**What was caught:** The spec used `DeepPartial<Settings>` in AC1 without noting it needs to be created.
**Why I missed it:** Assumed the type name was self-documenting enough. Didn't verify existence.
**Prompt fix:** Add to `/elaborate` step 2 (Parse spec completeness): "Flag any type/interface/utility referenced in AC that doesn't exist in the codebase yet. Mark as gap to fill."

### F4: Server wrapper migration pattern unspecified
**What was caught:** Server tests use `createMockSettingsService()` wrappers (not raw `AppSettings` objects), and the spec didn't address how these should consume the shared factory.
**Why I missed it:** Treated "settings fixtures" as one pattern. The subagent identified the server wrappers but the spec only added them to the blast radius list, not to the migration strategy.
**Prompt fix:** Add to `/elaborate` subagent prompt (step 3, item 12): "For each mock pattern variant found, note how the migration should work — don't just list the files, describe the migration rule per pattern."
