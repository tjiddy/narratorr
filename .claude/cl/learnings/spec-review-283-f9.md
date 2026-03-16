---
scope: [scope/backend]
files: [src/server/services/quality-gate.service.ts]
issue: 283
source: spec-review
date: 2026-03-10
---
Book status reversion in QualityGateService (autoReject and reject both revert book to wanted/imported) was missed in the `book_status_change` emission site audit. This is the same root cause as F8 -- the status mutation search didn't cover quality-gate.service.ts. Prevention: same fix as F8. Additionally, when a spec includes "review_needed" as an in-scope event, trace the full review lifecycle (hold -> approve/reject) to find all status mutations in the review flow, not just the hold trigger.
