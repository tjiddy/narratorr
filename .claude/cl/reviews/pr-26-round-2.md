---
skill: respond-to-pr-review
issue: 26
pr: 45
round: 2
date: 2026-03-20
fixed_findings: [F1]
---

### F1: Missing absence assertion for removed Prowlarr CTA

**What was caught:** The test that opened the Prowlarr modal was deleted, but no replacement negative assertion was added. If the button were accidentally reintroduced, the remaining tests would still pass.

**Why I missed it:** The focus during implementation was on removing code — deleted the feature test alongside the feature. The mental model was "test deleted with the feature", not "the absent feature needs its own assertion". This is a systematic gap in deletion-task thinking.

**Prompt fix:** Add to CLAUDE.md Gotchas or to the `/implement` skill: "When deleting a UI element (button, modal, nav item), the old positive interaction test must be REPLACED with an absence assertion (`screen.queryByRole(...)` returns null / `screen.queryByText(...)` returns null). Deleting the old test without a replacement leaves a regression gap — if the element is accidentally reintroduced, the suite still passes."
