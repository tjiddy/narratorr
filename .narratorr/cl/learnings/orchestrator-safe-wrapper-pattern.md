---
scope: [scope/backend, scope/services]
files: [src/server/services/download-orchestrator.ts]
issue: 434
date: 2026-03-18
---
When orchestrating multiple fire-and-forget side effects after a core operation, wrap each call in an independent try/catch (the `safe()` pattern) rather than grouping them in a single try/catch. A single try/catch stops all remaining side effects when one throws. The ImportOrchestrator's helpers are internally safe, but wrapping at the orchestrator level too prevents architectural drift if a helper is later refactored to throw.
