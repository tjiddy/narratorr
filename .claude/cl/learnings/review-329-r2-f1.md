---
scope: [infra]
files: [Dockerfile]
issue: 329
source: review
date: 2026-03-11
---
When deleting config files (postcss.config.js, tailwind.config.js) during a build toolchain migration, the Dockerfile's COPY commands must be updated too. The previous dispute of F4 ("Docker validation redundant when local build passes") was wrong — the reviewer was right that config file deletions interact with the Dockerfile's COPY list, which `pnpm build` alone doesn't exercise. Self-review should always check Dockerfile COPY statements when deleting any root-level config file.
