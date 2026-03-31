---
scope: [backend]
files: [src/server/services/quality-gate-orchestrator.ts]
issue: 247
date: 2026-03-31
---
`recordDecision()` in QualityGateOrchestrator hardcoded `eventType: 'held_for_review'` regardless of the action parameter. When adding fire-and-forget side-effect methods called from multiple branches, the eventType/payload should be derived from the action context — or better, only call the method from the branch where it's semantically correct. Calling a "record decision" method from paths that don't actually hold for review creates noise history.
