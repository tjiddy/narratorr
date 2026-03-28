---
skill: respond-to-pr-review
issue: 50
pr: 52
round: 2
date: 2026-03-21
fixed_findings: [F5]
---

### F5: Breadcrumb buttons in the form still untested
**What was caught:** The test name said "breadcrumb" but never clicked a breadcrumb button — only Cancel, Close, directory-row, and Select were exercised.
**Why I missed it:** The test was written as a single scenario covering multiple dismiss paths, but the breadcrumb interaction was added to the name without a corresponding userEvent step. The oversight came from conflating "described in the name" with "exercised in the body."
**Prompt fix:** Add to respond-to-pr-review step 3: "For tests that list multiple interaction types in their name (e.g., 'Cancel, Close, breadcrumb, directory-row'), verify there is a userEvent.click() call for each named interaction type — not just the ones that were easy to implement."
