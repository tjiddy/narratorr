---
scope: [infra]
files: [scripts/gitea.ts, scripts/update-labels.ts]
issue: 323
date: 2026-03-09
---
Gitea's API uses `/issues/{id}/labels` for both issues and PRs — there is no `/pulls/{id}/labels` endpoint. The `pr-update-labels` command correctly uses the issues namespace. Self-review subagents may flag this as a bug; it's not.
