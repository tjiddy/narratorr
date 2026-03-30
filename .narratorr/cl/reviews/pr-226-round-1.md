---
skill: respond-to-pr-review
issue: 226
pr: 230
round: 1
date: 2026-03-30
fixed_findings: [F1, F2, F3]
---

### F1: Untested start/end boundary guards
**What was caught:** `pos > 0` (Backspace) and `pos < val.length` (Delete) guards were new branches with no test coverage.
**Why I missed it:** The self-review coverage subagent flagged these but I treated them as "obviously correct" no-ops. The test plan focused on positive behavior (token deletion works) and negative passthrough (stray braces fall through) but didn't systematically enumerate every new branch.
**Prompt fix:** Add to `/handoff` step 4 coverage subagent prompt: "For each conditional guard in the diff (pos > 0, pos < length, ref.current check), verify there is an explicit test that exercises the guard's boundary value. Guards that are trivially correct still need tests because removing them silently changes behavior."

### F2: Delete-side regex rejection untested
**What was caught:** The Backspace path had a regex-rejection test (`{not a token}`) but the symmetric Delete path did not.
**Why I missed it:** I wrote Backspace tests first with full coverage, then wrote Delete tests by copying the pattern but skipped the regex-rejection case — asymmetric coverage from copy-paste test development.
**Prompt fix:** Add to `/plan` step 5 (test stub extraction): "When two code paths share the same structure (e.g., Backspace/Delete, add/remove, enable/disable), generate test stubs symmetrically — every test category applied to one path must also appear for the other."

### F3: TOKEN_BOUNDARY_REGEX duplicates naming grammar
**What was caught:** A third copy of the token regex was added in the component instead of reusing the existing definition from naming.ts.
**Why I missed it:** The regex was small enough that copying seemed faster than importing. The explore subagent noted the existing regex locations but didn't flag DRY-2 since the plan didn't touch those files.
**Prompt fix:** Add to `/plan` step 3 explore prompt: "When the plan introduces a regex, constant, or validation function, grep the codebase for the same pattern. If it already exists, the plan must import or derive from the existing definition — never introduce a parallel copy."
