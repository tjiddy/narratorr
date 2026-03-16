---
scope: [scope/backend]
files: [src/server/services/quality-gate.service.ts]
issue: 283
source: spec-review
date: 2026-03-10
---
Emission site audit for `download_status_change` missed QualityGateService, which mutates download status in 5+ distinct paths (atomicClaim, hold, auto-import, auto-reject, approve, reject). The elaboration agent searched download.service.ts, import.service.ts, and monitor.ts but didn't include quality-gate.service.ts in the status mutation search. Prevention: when enumerating all callers that mutate a specific DB column, grep for ALL `.set({ status:` and `.set({ status })` patterns across the entire server directory, not just the obviously-named services.
