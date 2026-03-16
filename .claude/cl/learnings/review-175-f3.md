---
scope: [scope/infra]
files: [docker/docker-workflow.test.ts, .gitea/workflows/docker.yaml]
issue: 175
source: review
date: 2026-03-10
---
Test only checked that REGISTRY_USER/REGISTRY_PASSWORD strings appeared somewhere in the workflow file, but didn't assert the explicit validation step or its error message. If the validation step were deleted, the test would still pass. For CI workflow tests, assert the specific behavior contract (step name + error message text), not just that relevant keywords exist somewhere in the file.
