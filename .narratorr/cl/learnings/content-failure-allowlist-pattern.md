---
scope: [backend]
files: [src/server/services/import-orchestrator.ts, src/server/utils/import-steps.ts, src/core/utils/audio-processor.ts]
issue: 504
date: 2026-04-12
---
When classifying errors by message content, use a positive allowlist (only match known-good patterns) rather than a negative blocklist (exclude known-bad patterns). `processAudioFiles()` wraps both media errors and I/O/tooling errors in the same catch block, making negative exclusion fragile. The spec review caught this across 3 rounds before converging on the allowlist approach.
