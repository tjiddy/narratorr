---
scope: [scope/infra]
files: []
issue: 412
source: spec-review
date: 2026-03-16
---
AC2/AC3 required "clear error" but didn't specify the error propagation contract between `checkoutOrCreateBranch()` (helper) and `claim.ts` (CLI). The gap: when a spec touches a helper that's called by a CLI script, the AC needs to define which layer owns error formatting. Checking the existing error patterns in `claim.ts` (all use `die(...)`) would have made this obvious during spec writing.
