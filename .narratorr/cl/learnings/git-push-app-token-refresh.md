---
scope: [infra]
files: [scripts/lib.ts]
issue: 79
date: 2026-03-24
---
`git push` fails with "Authentication failed" when GH_TOKEN in the environment is stale (GitHub App installation tokens expire). The `gh` CLI wrapper in `scripts/lib.ts` refreshes the token for API calls but doesn't update the env for git. Workaround: build a fresh token inline using the app JWT, then embed it in the remote URL: `https://x-access-token:<token>@github.com/owner/repo.git`.
