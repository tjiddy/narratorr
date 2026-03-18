---
skill: respond-to-spec-review
issue: 428
round: 2
date: 2026-03-17
fixed_findings: [F4]
---

### F4: Runner-stage runtime artifacts under-specified
**What was caught:** The revised Docker AC said to copy the "Node binary" from builder, but the runner stage still needed `corepack` and `pnpm` for `pnpm install --prod`. Copying only the binary would break the existing install flow.
**Why I missed it:** When fixing F1 (Alpine doesn't have Node 24 packages), I focused on how to get the Node runtime into the runner but didn't trace the downstream `RUN` commands that depend on package manager tooling. I treated the runner's `corepack enable` + `pnpm install --prod` as separate from the Node install strategy when they're actually coupled.
**Prompt fix:** Add to `/respond-to-spec-review` step 6 verification checklist: "For Dockerfile changes, trace every `RUN` command in affected stages — verify all binaries, shims, and filesystem paths they depend on are still available after the proposed change."
