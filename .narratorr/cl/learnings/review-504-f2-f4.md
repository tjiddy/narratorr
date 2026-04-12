---
scope: [backend]
files: [src/server/services/import-orchestrator.test.ts]
issue: 504
source: review
date: 2026-04-12
---
When delegating to a shared helper (blacklistAndRetrySearch), assert the full contract at the delegation point — not just the domain-specific args (reason, blacklistType) but also the wiring args (settingsService, retrySearchDeps) and the absence of override flags (overrideRetry). Also assert fire-and-forget .catch() log messages to prove the failure path is observable.
