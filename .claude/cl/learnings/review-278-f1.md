---
scope: [backend, core]
files: [packages/core/src/notifiers/registry.ts, apps/narratorr/src/server/services/notifier.service.ts]
issue: 278
source: review
date: 2026-03-06
---
When extracting adapter creation into a factory map (ADAPTER_FACTORIES), side effects like logging get lost because factories don't have logger access. The webhook case had a `this.log.warn()` for malformed header JSON that silently disappeared into a try/catch returning undefined. Service-level observability concerns (logging, metrics) must stay in the service even when creation logic is delegated to a registry. Check existing tests for logging assertions before refactoring — the service test at line 217 caught this.
