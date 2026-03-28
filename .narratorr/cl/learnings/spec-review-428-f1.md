---
scope: [scope/infra]
files: []
issue: 428
source: spec-review
date: 2026-03-17
---
Reviewer caught that `apk add 'nodejs~=24'` is impossible on Alpine 3.21 — the repo only ships Node 22. The spec assumed Alpine package availability without verification. A live `docker run` check against the target base image would have caught this instantly. For any spec involving Docker package installs, verify package availability against the actual base image before writing the AC.
