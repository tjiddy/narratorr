---
scope: [scope/backend, scope/services]
files: []
issue: 359
source: spec-review
date: 2026-03-14
---
Spec review caught that the test plan had no verification for M-4 (barrel export), L-21 (semaphore encapsulation), or L-23 (import consistency). Root cause: these were "low" findings that seemed self-evident and didn't get test plan entries. Would have been prevented by a mechanical check in `/elaborate`: after writing AC, verify every AC item has at least one corresponding test plan entry.
