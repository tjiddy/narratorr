---
scope: [scope/infra]
files: [docker/s6-service.test.ts]
issue: 428
source: review
date: 2026-03-17
---
Reviewer caught that the Docker regression test suite passed while the actual Docker build was broken. The new 3-stage assertions only checked for Node binary and node_modules copy patterns, not for migration file availability.

Root cause: when adding regression tests for the Dockerfile rewrite, I focused on the new things (deps stage, node binary copy) and forgot to cover the existing things that could break (drizzle migration files). The test suite is text-pattern-based, so it can't catch a real build failure — but it should at least assert that every `COPY --from=` in the runner has a corresponding source in its origin stage.

Prevention: when rewriting Docker stages, ensure regression tests cover all `COPY --from=<stage>` lines, not just the new ones. Each cross-stage copy is an integration point that can break independently.
