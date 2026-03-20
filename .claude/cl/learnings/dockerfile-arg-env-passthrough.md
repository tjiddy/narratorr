---
scope: [infra]
files: [Dockerfile]
issue: 37
date: 2026-03-20
---
Docker ARG values are not automatically available as env vars in RUN commands — you must prefix the RUN: `RUN GIT_COMMIT=$GIT_COMMIT pnpm build`. Just declaring `ARG GIT_COMMIT` makes it available for expansion but not as a persistent env var. The builder stage also doesn't have access to `.git`, so the SHA must be passed as `--build-arg GIT_COMMIT=$(git rev-parse --short HEAD)` from the CI/local build command.
