---
scope: [backend, services]
files: [src/server/services/library-scan.service.test.ts]
issue: 176
source: review
date: 2026-03-28
---
When adding background-path tests for a guard, asserting only the primary side effect (`status: 'missing'`) is insufficient — the spec defines a multi-part contract (missing status + import_failed event + no filesystem ops). The coverage subagent during handoff only checked for the status assertion and skipped the event side effect. When the spec's "System Behaviors" section lists multiple outcomes for a failure path, each outcome needs its own `expect()` assertion in the test, not just the most visible one.
