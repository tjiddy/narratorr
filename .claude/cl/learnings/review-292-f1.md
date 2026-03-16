---
scope: [backend, infra]
files: [docker/root/etc/s6-overlay/s6-rc.d/svc-narratorr/run]
issue: 292
source: review
date: 2026-03-10
---
Git on Windows doesn't track Unix file permissions by default. Shell scripts (especially s6 service `run` files) MUST be committed with executable bit via `git update-index --chmod=+x`. Without this, the file copies into the Docker image as 644 and s6-overlay can't exec it — silent container startup failure. Always verify with `git ls-tree HEAD -- <path>` after committing shell scripts.
