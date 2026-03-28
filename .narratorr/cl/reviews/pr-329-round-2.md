---
skill: respond-to-pr-review
issue: 329
pr: 340
round: 2
date: 2026-03-11
fixed_findings: [F1]
---

### F1: Dockerfile COPY references deleted config files
**What was caught:** The Dockerfile builder stage still copies `postcss.config.js` and `tailwind.config.js`, which were deleted during the Tailwind 4 migration. Docker build fails at line 17.
**Why I missed it:** In round 1, I disputed the Docker validation finding (F4) arguing it was redundant with CI. The reviewer proved me wrong — config file deletions create a concrete interaction with the Dockerfile that `pnpm build` alone doesn't catch. I should have checked the Dockerfile when deleting root-level config files.
**Prompt fix:** Add to `/handoff` self-review step 2: "When any root-level config file is deleted or renamed, check `Dockerfile` and `.dockerignore` for references to the old filename. These are not caught by `pnpm build` or `pnpm typecheck`."
