---
scope: [infra, core]
files: [scripts/lib.ts, scripts/git-push.ts]
issue: 94
date: 2026-03-26
---
When debugging `scripts/lib.ts` token generation, truncating the token for display (e.g., `substring(0,25)`) and then using that truncated string for git push will always fail — GitHub App installation tokens are 40 characters and must be used in full. The `scripts/git-push.ts` wrapper works correctly when `GH_APP_PRIVATE_KEY_PATH` is set, but the credential helper `!/usr/bin/gh auth git-credential` in `.gitconfig` overrides the token-in-URL when `GH_TOKEN` is expired — work around with `GH_TOKEN="" git -c credential.helper= push`.
