---
scope: [infra]
files: [scripts/setup-labels.ts, scripts/update-labels.ts]
issue: 323
date: 2026-03-09
---
Labels must exist in Gitea before they can be set on issues/PRs. When adding new labels (like `status/in-review`), create them with `gitea label-create` BEFORE running `update-labels.ts`. Otherwise the label is silently dropped during the PUT request. The `setup-labels.ts` script defines canonical labels but must be run or individual labels created manually.
