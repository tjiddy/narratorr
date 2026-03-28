---
skill: respond-to-pr-review
issue: 147
pr: 156
round: 2
date: 2026-03-27
fixed_findings: [F6, F7, F8, F9]
---

### F6: useFetchCategories non-Error fallback untested
**What was caught:** The 'Failed to fetch categories' fallback in useFetchCategories had no test. Only Error-typed rejections were covered.
**Why I missed it:** The round-1 response fixed 5 sites the reviewer enumerated, but didn't scan the full diff for all remaining instanceof-Error ternaries. The sibling check in step 3 should have been applied as "grep the entire diff for this pattern" not "check whether the file the reviewer flagged has siblings."
**Prompt fix:** Add to respond-to-pr-review step 3b (after fixing any "missing non-Error test" finding): "Run `git diff main -- '*.ts' '*.tsx' | grep 'instanceof Error ? error.message'` across the full diff. For every match not already covered by a non-Error test, add one before proceeding. This exhausts the sibling check in one pass rather than across multiple review rounds."

### F7: useMatchJob startMatching non-Error fallback untested
**What was caught:** The 'Unknown error' fallback in startMatching() had no hook test.
**Why I missed it:** Same as F6 — the round-1 sibling scan was file-scoped rather than diff-scoped.
**Prompt fix:** Same as F6 — exhaustive diff grep for instanceof-Error ternaries before pushing round-1 fixes.

### F8: useMatchJob poll non-Error fallback untested
**What was caught:** The 'Unknown error' fallback in the poll catch had no test. Two independent catch blocks in the same hook, both needed non-Error tests.
**Why I missed it:** Same as F6/F7. Even within the same file, the scan was incomplete.
**Prompt fix:** Same as F6 — a single diff-wide grep would have caught F7 and F8 together.

### F9: ProcessingSettingsSection ffmpeg probe non-Error fallback untested
**What was caught:** The 'ffmpeg probe failed' fallback rendered as visible text and in toast.error() had no test.
**Why I missed it:** Same systemic gap. This site was in the original diff from the start.
**Prompt fix:** Same as F6. The one-time exhaustive grep is the fix — not enumerating each instance ad hoc.
