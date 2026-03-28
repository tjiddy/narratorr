---
skill: respond-to-pr-review
issue: 428
pr: 438
round: 2
date: 2026-03-17
fixed_findings: [F1, F2]
---

### F1: Builder stage missing drizzle/ directory
**What was caught:** Runner's `COPY --from=builder /app/drizzle ./drizzle` fails because the builder stage never copies `drizzle/` into `/app`.
**Why I missed it:** During the Dockerfile restructure, I focused on what needed to change (adding deps stage, copying node binary) and didn't audit what existing `COPY --from=builder` lines in the runner still needed. The `drizzle/` directory is a static passthrough — not produced by `pnpm build` — so it's invisible to a "what does the build produce?" mental model.
**Prompt fix:** Add to `/plan` Dockerfile restructure guidance: "When modifying Docker stage boundaries, enumerate every `COPY --from=<stage>` in the final stage and verify each source path is populated in its origin stage. Static directories (migrations, configs) that aren't build outputs are the most likely to be missed."

### F2: Regression tests didn't cover migration artifact path
**What was caught:** Docker regression tests passed while `docker build` failed — tests only covered new 3-stage patterns, not the existing migration copy that broke.
**Why I missed it:** Test additions mirrored the code additions (new deps stage → new test, new node binary copy → new test) but didn't consider that restructuring stages could break existing cross-stage copies. The test strategy was "cover what I added" instead of "cover what could break."
**Prompt fix:** Add to `/implement` Docker test guidance: "When restructuring Dockerfile stages, regression tests must cover ALL `COPY --from=` lines in the final stage, not just new ones. Each cross-stage copy is an independent failure point."
