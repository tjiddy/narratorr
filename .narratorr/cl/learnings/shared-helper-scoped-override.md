---
scope: [backend]
files: [src/server/utils/rejection-helpers.ts, src/server/services/quality-gate-orchestrator.ts]
issue: 301
date: 2026-04-02
---
When a shared helper (blacklistAndRetrySearch) is used by multiple callers with different behavior requirements, add an opt-in override flag (overrideRetry) rather than changing the global default. This preserves backward compatibility for all existing callers (BookRejectionService) while letting specific callers (manual reject with retry=true) override gated behavior. The conditional skip of the entire helper call (`if (retry) { blacklistAndRetrySearch(...) }`) is cleaner than adding flags for partial skip.
