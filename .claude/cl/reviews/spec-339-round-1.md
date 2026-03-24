---
skill: respond-to-spec-review
issue: 339
round: 1
date: 2026-03-11
fixed_findings: [F2, F3, F4, F5]
---

### F2: Pattern A file inventory incomplete
**What was caught:** 3 settings test files (SearchSettingsSection, ImportSettingsSection, QualitySettingsSection) had the same flaky `toHaveValue` assertions but were only listed under Pattern B, not Pattern A.
**Why I missed it:** The spec listed these files under Pattern B (number input clear/type), but didn't cross-reference that they also need Pattern A treatment (waitFor wrapping on the `toHaveValue` assertions). The elaboration subagent spot-checked for Pattern A instances but didn't systematically verify every Pattern B file also needed Pattern A.
**Prompt fix:** Add to `/elaborate` step 3 subagent prompt: "For issues with multiple fix patterns, verify every file listed under one pattern against ALL other patterns — files frequently need fixes from multiple patterns simultaneously."

### F3: Unsupported Vitest --repeat flag
**What was caught:** `--repeat=10` doesn't exist in Vitest 4.x, making the test plan commands non-executable.
**Why I missed it:** Assumed the flag existed without running it. The elaboration added test plan items using this flag from the original spec without verifying.
**Prompt fix:** Add to `/elaborate` step 4 (test plan gap-fill): "Before adding CLI commands to the test plan, verify they execute successfully against the repo's installed tool versions. Run a quick smoke test of any non-trivial flags."

### F4: Contradictory AC pass thresholds
**What was caught:** AC4 said "12 passing runs" but also "(run 3x in CI or locally)" — two different numbers for the same gate.
**Why I missed it:** The elaboration focused on adding missing test plan items and didn't audit existing AC for internal consistency.
**Prompt fix:** Add to `/elaborate` step 2 (parse spec completeness): "Check AC items for internal consistency — if an item references a numeric threshold, verify it's stated exactly once without contradictory alternatives."

### F5: Missing NotificationsSettings from Pattern C blast radius
**What was caught:** crud-settings-helpers is imported by 3 test files but the test plan only mentioned 2.
**Why I missed it:** The elaboration subagent found all 3 consumers but the test plan item I added only mentioned "e.g., IndexersSettings, DownloadClientsSettings" without listing all consumers.
**Prompt fix:** When gap-filling test plans for shared helper changes, always grep for all consumers and list them exhaustively — never use "e.g." with a partial list.
