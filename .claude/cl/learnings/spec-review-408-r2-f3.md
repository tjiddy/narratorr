---
scope: [scope/backend]
files: []
issue: 408
source: spec-review
date: 2026-03-17
---
Reviewer caught that the Re-score on Import test plan said reason/reasonContext are preserved for all import-affected pending suggestions, but AC6 only defines preservation for resurfaced snoozed rows. The test plan was written with broader language than the AC it was testing. Prevention: when writing test plan items that reference a specific AC, re-read the AC text and match the scope exactly. If the test plan item covers a broader case than the AC, either narrow the test or expand the AC.
