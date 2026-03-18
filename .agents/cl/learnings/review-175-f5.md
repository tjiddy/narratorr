---
scope: [scope/infra]
files: [.gitea/workflows/docker.yaml, docker/docker-workflow.test.ts]
issue: 175
source: review
date: 2026-03-10
---
The issue test plan explicitly called for `docker buildx imagetools inspect` to verify the multi-arch manifest post-push, but the workflow only built and pushed without verifying. When the test plan names a specific verification tool/command, the workflow must include that step — building for multiple platforms doesn't prove the manifest was published correctly. Always cross-check the test plan items against the workflow steps 1:1.
