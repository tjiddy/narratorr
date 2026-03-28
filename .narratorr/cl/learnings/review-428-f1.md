---
scope: [scope/infra]
files: [Dockerfile]
issue: 428
source: review
date: 2026-03-17
---
Reviewer caught that the 3-stage Dockerfile rewrite broke the build because the runner's `COPY --from=builder /app/drizzle ./drizzle` references a path that the builder stage never created. The builder only copied `src/` and config files, not `drizzle/`.

Root cause: when restructuring Docker stages, I audited what the runner needed but didn't verify that every `COPY --from=builder` source path actually exists in the builder stage. The build command (`pnpm build`) doesn't touch `drizzle/` — it's a static directory that just needs to be passed through.

Prevention: when adding or modifying `COPY --from=<stage>` lines, trace each source path back to confirm the named stage actually contains it. Static directories that aren't produced by a build step are easy to miss.
