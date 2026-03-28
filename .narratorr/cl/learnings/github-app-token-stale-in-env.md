---
scope: [infra]
files: [scripts/lib.ts]
issue: 106
date: 2026-03-25
---
The `GH_TOKEN` env var can be stale (expired installation token from session start). `gh auth status` will show "invalid token" even though fresh tokens can be obtained via `scripts/lib.ts` (which re-mints via the GitHub App private key). For git push, the remote URL must be updated with a freshly-minted token: run `npx tsx /tmp/get-token.ts` (a standalone script that calls the GitHub App access_tokens endpoint), then `git remote set-url origin "https://x-access-token:<fresh-token>@github.com/..."`. The `getGhToken()` in lib.ts handles this automatically for gh CLI calls but not for raw git operations.
