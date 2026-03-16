---
scope: [scope/frontend]
files: []
issue: 362
source: spec-review
date: 2026-03-13
---
Reviewer caught that M-31 (`fireEvent.change` on number inputs) had already been cleaned up by #339 — zero matches remain in `src/client`. The `/elaborate` skill built the spec from a stale debt scan artifact (`debt-scan-findings.md`) that doesn't even exist in the repo, without verifying the findings against the current codebase. The fix: `/elaborate` must `rg` for each cited pattern before including it in the spec. Never trust a secondary source (debt scan, prior issue) without verifying the current state.
