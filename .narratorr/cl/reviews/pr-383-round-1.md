---
skill: respond-to-pr-review
issue: 383
pr: 384
round: 1
date: 2026-03-15
fixed_findings: [F1]
---

### F1: Missing runtime Node version assertion in Docker workflow
**What was caught:** The release smoke test only checks `/api/health` returns 200, never verifies `node --version` inside the container matches v22.*.
**Why I missed it:** Self-review flagged the Dockerfile pinning and test assertion gaps, which I fixed. But I only added a string assertion on the Dockerfile text — I didn't think to also add a runtime assertion to the CI workflow. The mental model was "pin it and test the pin" when it should have been "pin it, test the pin, AND test the runtime output."
**Prompt fix:** Add to `/handoff` step 2 infrastructure artifact check: "For Dockerfile version changes, verify that CI workflows contain runtime version assertions (e.g., `docker exec <container> node --version`), not just string-level Dockerfile content checks."
