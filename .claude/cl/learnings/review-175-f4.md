---
scope: [scope/infra]
files: [docker/docker-workflow.test.ts, .gitea/workflows/docker.yaml]
issue: 175
source: review
date: 2026-03-10
---
Tag contract tests only asserted "latest" and generic ref-name usage, but didn't verify the exact `steps.version.outputs.version` and `steps.version.outputs.major_minor` interpolation strings in the tags block. For CI workflows, each published tag should have a test asserting the exact template expression, not just that some version-related keyword exists.
