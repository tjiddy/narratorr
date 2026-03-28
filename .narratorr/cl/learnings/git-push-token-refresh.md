---
scope: [backend]
files: [scripts/lib.ts]
issue: 82
date: 2026-03-25
---
GitHub App installation tokens expire (~1h). When `gh auth status` shows "token invalid", `git push` also fails because the remote URL embeds the old token. Workaround: generate a fresh JWT+installation token inline using `npx tsx -e "..."` (node:crypto + curl), then `git remote set-url origin "https://x-access-token:<token>@github.com/..."`. The `node --import tsx -e` pattern fails with ESM syntax errors; use `npx tsx -e` instead. The `GH_TOKEN` env var must be exported to work with `gh` CLI commands during the same shell session.
