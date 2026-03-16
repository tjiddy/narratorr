---
scope: [scope/infra]
files: [Dockerfile, docker/healthcheck.test.ts]
issue: 284
source: review
date: 2026-03-10
---
Reviewer caught that the Docker HEALTHCHECK command using `${URL_BASE:-}` shell expansion had no test proving it resolves correctly for both root and subpath deployments.

**Root cause:** Dockerfile instructions are typically considered "config, not code" and don't get tested. But shell variable expansion in HEALTHCHECK is behavioral logic that can break deployments if the syntax is wrong.

**Prevention:** Any shell variable expansion in Docker infrastructure (HEALTHCHECK, ENTRYPOINT, ENV defaults) that affects runtime behavior should have a corresponding test that exercises the expansion via bash. The same `execFileSync('bash', [tmpScript])` pattern used for entrypoint testing works perfectly here.
