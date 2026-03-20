---
scope: [backend]
files: [scripts/lib.ts]
issue: 21
date: 2026-03-20
---
The git remote URL is set with a GitHub App installation token (format: `https://x-access-token:<token>@github.com/...`). These tokens expire after ~1 hour. When `git push` fails with "Invalid username or token", refresh the token by calling `gh('auth', 'token')` via `scripts/lib.ts`'s `gh()` function (which internally calls `getGhToken()` to get a fresh installation token), then update the remote URL with `git remote set-url origin "https://x-access-token:<fresh>@..."`. Same pattern needed for `gh pr create` — use `GH_TOKEN="$FRESH_TOKEN" gh pr create ...`.
