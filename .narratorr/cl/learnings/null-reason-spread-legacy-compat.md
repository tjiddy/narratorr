---
scope: [backend]
files: [src/server/services/quality-gate.service.ts, src/server/services/quality-gate.types.ts]
issue: 300
date: 2026-04-02
---
When extending JSON payloads stored in the DB (like `QualityDecisionReason`), previously persisted records won't have the new fields. Direct type casts (`as QualityDecisionReason`) make missing fields `undefined`, not `null`, which breaks `!== null` guards in consumers. The fix is `{ ...NULL_REASON, ...stored }` at readback — the sentinel constant provides defaults for all fields. This pattern was already used in the orchestrator for probe failures; extending it to the readback path was the natural fix.
