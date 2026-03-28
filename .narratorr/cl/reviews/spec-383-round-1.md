---
skill: respond-to-spec-review
issue: 383
round: 1
date: 2026-03-15
fixed_findings: [F1, F2, F3]
---

### F1: Docker runner-stage Node version not verified
**What was caught:** AC and test plan only checked `/api/health` returns 200, never verified `node --version` inside the container. Runner stage installs Node via `apk add nodejs` (floating Alpine version).
**Why I missed it:** Focused on the builder stage `FROM node:20-alpine` and assumed the runner would inherit or match. Didn't trace the multi-stage build to notice the runner installs Node independently.
**Prompt fix:** Add to `/spec` quality checks: "For Dockerfile changes, trace each stage's dependency sources independently. Multi-stage builds can have different versions of the same tool if one uses a base image and another uses a package manager."

### F2: README left stale after version bump
**What was caught:** README.md references Node.js 20+ in prerequisites and tech stack, but scope only listed runtime/CI files.
**Why I missed it:** Treated this as a pure infrastructure chore and didn't think about contributor-facing docs. The overview said "all project targets" but scope boundaries didn't match.
**Prompt fix:** Add to `/spec` scope check: "When changing version requirements, grep for the old version string across docs (README, CONTRIBUTING, etc.) and include any matches in scope."

### F3: Unverifiable historical claim in technical notes
**What was caught:** Technical note stated definitively that jest-dom/TS2769 issues were caused by stale `node_modules`, but there's no repo evidence for that diagnosis.
**Why I missed it:** The claim was based on live debugging in conversation, which felt authoritative in the moment. Didn't consider that spec readers wouldn't have that context.
**Prompt fix:** Add to `/spec` quality checks: "Technical notes should be verifiable from the repo. If a claim comes from live debugging or conversation context, frame it as 'prior investigation suggested' and point to executable AC as the source of truth."
