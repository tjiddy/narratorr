---
scope: [backend]
files: [src/server/services/discovery.service.ts, src/server/routes/index.ts]
issue: 341
date: 2026-04-04
---
DiscoveryService was the only BookService.create() caller that lacked EventHistoryService injection. When adding cross-cutting event recording, check ALL callers' constructor signatures against the service graph in routes/index.ts — don't assume every service has the same dependencies. The optional parameter pattern (`private eventHistory?: EventHistoryService`) with guard (`if (this.eventHistory)`) is the established way to add event recording without breaking existing callers.
