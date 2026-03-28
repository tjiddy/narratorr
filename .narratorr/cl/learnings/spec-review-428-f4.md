---
scope: [scope/infra]
files: []
issue: 428
source: spec-review
date: 2026-03-17
---
Reviewer caught that "copy Node binary from builder" under-specifies the runtime artifacts needed by the runner stage. The Dockerfile's runner stage also depends on `corepack enable` and `pnpm install --prod`, which require more than just `/usr/local/bin/node`. The spec should have traced the full runner-stage dependency chain (node binary → corepack → pnpm → node_modules) and chosen a concrete strategy that accounts for all of them. A multi-stage deps approach (pre-build node_modules in a separate stage, copy into runner) eliminates the need for package manager tooling in the runner entirely. When specifying Docker strategy changes, trace every `RUN` command in the affected stage to verify all its dependencies are still satisfied.
