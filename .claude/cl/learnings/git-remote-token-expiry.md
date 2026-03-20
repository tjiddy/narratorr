---
scope: [infra]
files: []
issue: 37
date: 2026-03-20
---
The git remote URL embeds a token (`https://x-access-token:<TOKEN>@github.com/...`). This token can expire mid-session while `gh auth token` issues a fresh one. When `git push` fails with "Invalid username or token", run `git remote set-url origin "https://x-access-token:$(gh auth token)@github.com/<owner>/<repo>.git"` to refresh it. Don't assume the embedded token in `git remote get-url` is still valid.
