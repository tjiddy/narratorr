---
skill: respond-to-pr-review
issue: 217
pr: 222
round: 1
date: 2026-03-30
fixed_findings: [F1, F2]
---

### F1: Token insertion position not asserted precisely
**What was caught:** Test used `toContain('{series}')` which doesn't prove append-at-end semantics.
**Why I missed it:** The coverage review subagent flagged the weak assertion and I strengthened it to `toContain`, but didn't go far enough to assert the exact position. The `toContain` fix was treated as sufficient during implementation.
**Prompt fix:** Add to `/implement` step 4a test depth rule: "For cursor-position-dependent operations, assert the exact resulting string, not just that the inserted content appears somewhere in the output."

### F2: Selected-text replacement branch untested
**What was caught:** `insertTokenAtCursor` has a `selectionStart`/`selectionEnd` path for replacing selected text, but no test exercised it.
**Why I missed it:** The test plan had a bullet for "selected text replaced with token" but during implementation I only wrote the happy-path insertion test and the panel-stays-open test, skipping the selection replacement case. The plan-to-test mapping wasn't 1:1.
**Prompt fix:** Add to `/implement` step 4a: "Cross-check each test plan bullet against written tests before committing the module. Every boundary/edge-case bullet must have a corresponding test — not just the happy path."
