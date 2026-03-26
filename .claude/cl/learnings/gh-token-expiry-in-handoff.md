---
scope: [backend]
files: [scripts/lib.ts, scripts/git-push.ts]
issue: 139
date: 2026-03-26
---
The `GH_TOKEN` environment variable can expire mid-session (GitHub App installation tokens expire after ~1 hour). `scripts/git-push.ts` handles this transparently via `getGhToken()`, but when calling `gh` CLI directly in handoff flows (e.g., `gh pr create`, `gh issue comment`), you must mint a fresh token manually. The quickest workaround: use the JWT-mint + installation-token exchange logic inline (from `scripts/lib.ts` lines 24-79), set the result as `GH_TOKEN` before any `gh` CLI calls.
