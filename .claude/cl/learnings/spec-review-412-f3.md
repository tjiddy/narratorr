---
scope: [scope/infra]
files: []
issue: 412
source: spec-review
date: 2026-03-16
---
Test plan item 9 mentioned `resume.ts` as a "check if it also needs the fix" item, but the scope boundary only committed to `claim.ts`. This created ambiguity about whether `resume.ts` was in or out of scope. The gap: test plan items that reference code outside the declared scope should be moved to an explicit out-of-scope/follow-up section.
