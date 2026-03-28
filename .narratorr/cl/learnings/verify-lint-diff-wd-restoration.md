---
scope: [infra]
files: [scripts/verify.ts]
issue: 353
date: 2026-03-15
---
When verify.ts checks out merge-base to lint main's code, it must wrap the checkout in try/finally to always restore the feature branch working directory. Without this, a failure during the diff lint sequence leaves subsequent gates (test, typecheck, build) running against the wrong commit. Self-review caught this during handoff.
