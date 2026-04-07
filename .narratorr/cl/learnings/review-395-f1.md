---
scope: [scope/backend, scope/core]
files: [src/core/utils/detect-usenet-language.ts, src/server/utils/enrich-usenet-languages.ts]
issue: 395
source: review
date: 2026-04-07
---
Reviewer caught a reverse layer dependency: `src/core/` importing `src/server/utils/semaphore.ts` and taking a `FastifyBaseLogger`. CLAUDE.md says core adapters should not log — they throw errors or return failures for the caller to log.

Root cause: the plan co-located the enrichment orchestrator (which needs logging, HTTP fetching, and concurrency) with the pure detection functions in `src/core/utils/`. The plan's architecture check noted SRP-1 was "at threshold" but didn't flag the layer boundary violation.

Prevention: when `/plan` places a new file in `src/core/`, verify it imports nothing from `src/server/` and does not accept Fastify types. If it needs logging or server utilities, it belongs in `src/server/`.
