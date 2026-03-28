---
scope: [scope/backend]
files: []
issue: 408
source: spec-review
date: 2026-03-17
---
Reviewer caught that the Partial Failure Contract said "callers need no changes" while simultaneously requiring the discovery job to log warnings — the job currently only logs `{ added, removed }`. The spec missed it because the "no caller changes" claim was copied from the route handler truth (route does pass through the full result) without verifying the job caller separately. Prevention: when writing partial-failure contracts, verify each caller individually against the claimed behavior, not just the primary one.
