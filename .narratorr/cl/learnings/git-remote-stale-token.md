---
scope: [frontend]
files: []
issue: 58
date: 2026-03-22
---
The git remote URL embeds a GitHub App installation token (`https://x-access-token:<token>@github.com/...`). Installation tokens expire after 1 hour. When `git push` fails with "Authentication failed", the embedded token is stale. Fix: get a fresh token via `node -e "import('./scripts/lib.ts').then(l => process.stdout.write(l.gh('auth','token').trim()))"` then run `git remote set-url origin "https://x-access-token:<fresh_token>@github.com/..."`. The `gh` CLI will automatically use GH_TOKEN for API calls, but git operations use the URL-embedded token and need manual refresh.
