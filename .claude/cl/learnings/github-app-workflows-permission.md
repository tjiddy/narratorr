---
scope: [infra, backend]
files: [.github/workflows/docker.yml]
issue: 67
date: 2026-03-24
---
GitHub Apps require explicit `workflows` read/write permission to push branches that modify `.github/workflows/` files — the standard `contents: write` permission is not sufficient. Without it, `git push` is rejected with "refusing to allow a GitHub App to create or update workflow". Grant the `Workflows` permission in the GitHub App settings to unblock.
