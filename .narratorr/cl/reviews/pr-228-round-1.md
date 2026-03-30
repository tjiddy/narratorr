---
skill: respond-to-pr-review
issue: 228
pr: 232
round: 1
date: 2026-03-30
fixed_findings: [F1, F2, F3, F4]
---

### F1: hasTitle/hasAuthor do not honor suffix-first disambiguation
**What was caught:** `hasTitle()` and `hasAuthor()` used independent regex heuristics, so `{author?title}` falsely satisfied `hasTitle()`.
**Why I missed it:** I updated `validateTokens()` to use disambiguation but left `hasTitle`/`hasAuthor` as regex-only. The debt log already flagged these as using independent regexes, but I didn't act on it during implementation.
**Prompt fix:** Add to `/implement` step 4d (sibling enumeration): "After updating any token-matching logic, grep for ALL functions that match token names (`hasTitle`, `hasAuthor`, `validateTokens`, `parseTemplate`) and verify they all use the same disambiguation contract."

### F2: parseTemplate('') violates the spec's empty-template contract
**What was caught:** The spec says empty template → no errors, but the test codified the old behavior.
**Why I missed it:** During red-phase test writing, I noticed the old behavior and wrote the test to match it rather than the spec.
**Prompt fix:** Add to `/implement` step 4a (red phase): "When converting test stubs to real tests, re-read the spec's test plan bullet for each stub. If the spec explicitly defines a boundary value contract, assert that exact contract — not the pre-existing behavior."

### F3: Preview token-map behavior unproven at component level
**What was caught:** Tests only asserted label presence ("Multi-file" exists) but not the actual token maps passed to `renderFilename()`.
**Why I missed it:** I focused on visible UI output (labels) rather than the function arguments that drive the output.
**Prompt fix:** Add to testing.md under "Test quality standards": "When a component passes different data to the same function for different render paths (e.g., different token maps for preview rows), spy on the function and assert the exact arguments for each call. Label-only assertions prove the UI renders but not that the data contract is correct."

### F4: Delete-at-start path for prefix tokens untested
**What was caught:** Only the Backspace branch was tested; the Delete branch was not.
**Why I missed it:** The spec mentioned both Backspace and Delete, but I only wrote one test.
**Prompt fix:** Add to `/plan` step 5 (test stub extraction): "For keyboard handlers with multiple branches (e.g., Backspace vs Delete, ArrowUp vs ArrowDown), generate one stub per branch — not one stub for the handler."
