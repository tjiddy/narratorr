---
skill: respond-to-pr-review
issue: 246
pr: 251
round: 2
date: 2026-03-31
fixed_findings: [F6]
---

### F6: Whitespace-only seriesPosition passes validation and becomes 0
**What was caught:** `Number('   ')` returns `0` (not `NaN`), so the `.refine()` added for F3 didn't catch whitespace-only input. The submit handler then sent `seriesPosition: 0` instead of `undefined`.
**Why I missed it:** When fixing F3, I only tested alphabetic input ("abc") and didn't consider whitespace as a distinct edge case for `Number()` coercion. `Number()` has three surprising behaviors: `Number('')` → `0`, `Number('   ')` → `0`, `Number(null)` → `0`. Only non-numeric characters produce `NaN`.
**Prompt fix:** Add to CLAUDE.md Gotchas: "`Number()` coerces empty/whitespace strings to `0`, not `NaN`. When validating optional numeric string fields with Zod, always `.trim()` before `.refine()` so whitespace normalizes to empty string before the numeric check."
