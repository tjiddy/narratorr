---
skill: respond-to-pr-review
issue: 234
pr: 239
round: 1
date: 2026-03-31
fixed_findings: [F1]
---
### F1: Missing handleTest (by-ID) flicker prevention test
**What was caught:** The `handleTest` path was changed alongside `handleFormTest` (both had `setResult(null)` removed), but only the form path got a new regression test.
**Why I missed it:** The /plan step identified `useConnectionTest` as a single module and the spec's test plan only called out form-level flicker. When writing tests, I focused on the form path because that's what the spec described. I didn't systematically enumerate all changed code paths in the hook.
**Prompt fix:** Add to /implement step 4a: "When modifying a shared hook with multiple public methods (e.g., handleTest + handleFormTest), write a regression test for EVERY method that was changed — not just the one the spec calls out. Enumerate the changed methods from the diff and map each to a test."
