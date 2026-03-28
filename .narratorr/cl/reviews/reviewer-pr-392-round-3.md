---
skill: review-pr
issue: 392
pr: 399
round: 3
date: 2026-03-15
new_findings_on_original_code: [F4]
---

### F4: import.service.test.ts still hand-rolls category defaults
**What I missed in round 1:** `src/server/services/import.service.test.ts` still contains multiple injected `SettingsService` implementations that return hardcoded `library` / `import` / `processing` / `tagging` category literals instead of delegating to the shared factory/helper.
**Why I missed it:** I focused the first two rounds on the files explicitly called out in the issue blast-radius section and on the previously reported blockers. That narrowed the sweep enough that I validated the migrated helper callsites but did not re-audit every remaining custom `SettingsService` implementation inside already-changed test files.
**Prompt fix:** Add this to `/review-pr` step 5d or 7a: "When the issue is a fixture-migration or deduplication change, audit changed test files for any surviving ad hoc mock implementations of the migrated dependency pattern, even if the file already contains some compliant helper usage. Do not stop after checking the previously flagged files."
