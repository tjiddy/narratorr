---
skill: respond-to-pr-review
issue: 8
pr: 13
round: 3
date: 2026-03-19
fixed_findings: [F1]
---

### F1: theme tests exercise helper but not the production inline script in index.html
**What was caught:** `theme-bootstrap.ts` was created as a tested mirror of the `index.html` IIFE, but the `index.html` script never calls `applyTheme()`. So tests of the helper pass even if the real bootstrap is broken or deleted.
**Why I missed it:** I understood "extract to testable module" as the goal, but stopped short of ensuring the module was actually wired into production. The test suite proved the helper worked, not that the FOUC-prevention path worked.
**Prompt fix:** Add to `/plan` and `/implement` for any inline-HTML script extraction: "After extracting inline script logic to a module, verify either (a) the inline script calls the module function, or (b) tests read and eval() the actual inline script from the file. A helper with matching logic that is NOT called by the production path is a tested dead end, not test coverage."
