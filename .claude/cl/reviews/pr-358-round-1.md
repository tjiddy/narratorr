---
skill: respond-to-pr-review
issue: 358
pr: 370
round: 1
date: 2026-03-14
fixed_findings: [F1, F2]
---

### F1: Search settings validation coverage lost
**What was caught:** PR resolved merge conflicts in SearchSettingsSection.test.tsx by taking the "stashed" version, which lacked tests for numeric validation rejection (searchIntervalMinutes<5, blacklistTtlDays<1, rssIntervalMinutes<5) and edited numeric payload serialization.
**Why I missed it:** I focused on making the existing tests pass with the new method names and fixing the isDirty/Save button issue, but didn't compare the resolved test file against the upstream version to check for coverage regression. The self-review subagent and coverage review subagent both missed this because they only checked for coverage of *changed* source code, not for regression in *unchanged* behavior.
**Prompt fix:** Add to `/handoff` step 2 (self-review): "For files with merge conflict resolution (`git log --diff-filter=U` or files that had conflict markers), compare the resolved test count against `git show main:<file> | grep -c 'it('` to detect dropped test coverage."

### F2: Import settings validation coverage lost
**What was caught:** Same root cause as F1 — merge conflict resolution in ImportSettingsSection.test.tsx dropped `minSeedTime < 0` validation test and edited-field serialization test.
**Why I missed it:** Same as F1 — the merge conflict resolution was treated as a mechanical fix without auditing what coverage the "stashed" version lacked compared to the "upstream" version.
**Prompt fix:** Same as F1 — a single prompt addition would catch both.
