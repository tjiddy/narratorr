---
skill: respond-to-spec-review
issue: 353
round: 2
date: 2026-03-14
fixed_findings: [F6, F7]
---

### F6: W-6 `root/**` trigger does not exist in this repo
**What was caught:** The infra trigger list included `root/**` which matches nothing in this repo.
**Why I missed it:** Copied the path pattern from learning files about s6-overlay (`docker/root/`) and shortened it to `root/**` without verifying with `git ls-files`. The verify-before-writing step (step 6 of /respond-to-spec-review) should have caught this.
**Prompt fix:** Add to `/elaborate` step 4 gap-fill: "For all file path patterns in AC, verify they match actual files with `git ls-files <pattern>`. Non-matching patterns are spec defects."

### F7: W-8 file-level diffing insufficient for same-file pre-existing violations
**What was caught:** The merge-base + diff --name-only pattern from the coverage gate only identifies changed files, not changed violations within files.
**Why I missed it:** Pointed to an existing code pattern as the implementation hint without analyzing whether it was granular enough for the stated guarantee. The coverage gate checks file-level coverage percentage, where file granularity is sufficient. Lint diffing needs violation-level granularity.
**Prompt fix:** Add to `/elaborate` step 4: "When referencing an existing code pattern as an implementation hint, verify the pattern operates at the correct granularity for the new use case. File-level patterns are not always sufficient for violation-level guarantees."
