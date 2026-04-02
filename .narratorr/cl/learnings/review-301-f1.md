---
scope: [backend]
files: [src/server/routes/activity.ts]
issue: 301
source: review
date: 2026-04-02
---
Silent coercion of invalid input to a safe default (safeParse fallback to false) hides client bugs and changes user-visible behavior without feedback. When adding body schemas to existing endpoints, always validate and return 400 on failure rather than silently coercing — especially when the coerced value triggers a different code path (dismiss vs search). The Fastify body schema integration issue with empty bodies should be solved with `request.body ?? {}` before parsing, not by swallowing all parse failures.
