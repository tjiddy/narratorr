---
scope: [scope/frontend]
files: [src/client/pages/settings/BackupScheduleForm.test.tsx]
issue: 362
source: review
date: 2026-03-13
---
Reviewer caught that M-32 was still listed as in-scope in the issue spec but the PR only added comments explaining why it couldn't be done. When implementation discovers a constraint that makes an AC impossible, the issue spec must be formally updated with evidence-based rationale — not just a comment in the PR body or a modified checkbox. The gap was treating spec updates as optional when deferring scope during implementation.
