---
scope: [backend]
files: [src/server/services/import.service.ts, src/server/services/merge.service.ts, src/server/services/bulk-operation.service.ts]
issue: 240
source: review
date: 2026-03-31
---
When adding a new field to a shared config interface threaded through multiple callers, the middle-hop forwarding tests (import-steps.test.ts) are not sufficient — each service-level caller must also have an assertion that the field reaches the downstream function. Testing the helper and the processor independently does not prove the service wires them together. The coverage review subagent flagged this but the response was incomplete.
