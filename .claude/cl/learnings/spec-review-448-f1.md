---
scope: []
files: [.claude/cl/debt.md]
issue: 448
source: spec-review
date: 2026-03-18
---
Spec referenced debt.md entries (strike-through, cleanup sections) that had already been graduated out of the file by the time the reviewer checked. The spec was written against the state of debt.md when the issue was created, but debt.md was cleared between issue creation and spec review.

Root cause: The `/elaborate` skill added durable content referencing specific debt.md line items without considering that the debt file is a living document that changes independently of the issue. ACs should reference the work to be done, not the tracking artifact's internal state.

Prevention: When specs reference tracking artifacts (debt.md, workflow-log.md, etc.), write ACs in terms of the work outcome, not the artifact's contents. "Items 1, 6, 7 closed with rationale" is durable; "strike through in debt.md" is fragile.
