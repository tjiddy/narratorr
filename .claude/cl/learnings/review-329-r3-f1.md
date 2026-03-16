---
scope: [infra]
files: [Dockerfile]
issue: 329
source: review
date: 2026-03-11
---
Alpine's `nodejs` package doesn't include `corepack`, so `corepack enable` fails in the LinuxServer base image runner stage. Fix: install `npm` via apk and use `npm install -g pnpm@9`. This was a pre-existing issue from the Dockerfile created in #175/#338, not from this branch, but it blocks the Docker build AC. When a reviewer raises a finding about pre-existing code that blocks an AC, fix it rather than disputing scope — the AC doesn't care about blame.
