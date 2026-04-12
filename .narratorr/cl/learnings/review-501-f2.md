---
scope: [backend]
files: [src/server/routes/discover.test.ts]
issue: 501
source: review
date: 2026-04-12
---
When extracting a fire-and-forget side effect (like triggerImmediateSearch) to a shared module and calling it from a route, the route integration tests must mock and assert on the extracted function — not just test the helper in isolation. The helper tests verify internal behavior; the route tests verify the wiring contract (when is it called, with what args, and when is it NOT called). Missing the route-level mock means the side effect can be silently disconnected.
