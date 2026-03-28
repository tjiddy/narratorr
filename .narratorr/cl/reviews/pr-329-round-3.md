---
skill: respond-to-pr-review
issue: 329
pr: 340
round: 3
date: 2026-03-11
fixed_findings: [F1]
---

### F1: corepack not available in Alpine runner stage
**What was caught:** The Docker runner stage uses `corepack enable` but Alpine's `nodejs` package doesn't ship corepack, causing the build to fail.
**Why I missed it:** This was a pre-existing issue from the original Dockerfile (#175). I didn't attempt a Docker build locally (daemon unavailable) and assumed the existing Dockerfile was already working. In round 1, I disputed the Docker validation finding entirely rather than investigating what would happen.
**Prompt fix:** Add to `/handoff` self-review: "If the Dockerfile is in the changed file set OR the issue has a Docker build AC, attempt `pnpm docker:build` even if Docker availability is uncertain — document the result either way. If Docker is unavailable, at least read the Dockerfile and verify each `RUN` command's assumptions against the base image."
