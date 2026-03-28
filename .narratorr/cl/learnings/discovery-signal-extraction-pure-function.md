---
scope: [backend, services]
files: [src/server/services/discovery-signals.ts, src/server/services/discovery.service.ts]
issue: 366
date: 2026-03-16
---
Extracting signal analysis to a pure function (`extractSignals`) was required by the eslint complexity gate (max 15). The lesson: when a service method iterates over rows accumulating multiple signal types in one loop, the complexity explodes. Pre-plan extraction of accumulation logic to standalone pure functions — they're easier to test independently and avoid lint friction during implementation.
