---
scope: [backend, frontend, core]
files: [scripts/lib.ts]
issue: 26
date: 2026-03-20
---
The git remote URL is set to `https://x-access-token:<token>@github.com/...` with a hardcoded installation token that expires. When GH_APP_PRIVATE_KEY is not set (only GH_APP_ID), the lib.ts JWT signing fails and the stale token in the remote URL causes push to fail with "Invalid username or token." Fix: `git remote set-url origin "https://x-access-token:${GH_TOKEN}@github.com/..."` to use the current GH_TOKEN env var instead of the hardcoded stale one.
