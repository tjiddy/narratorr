---
scope: [type/chore, scope/infra]
files: [package.json]
issue: 329
source: spec-review
date: 2026-03-11
---
The audit disposition policy covered `review`-only actions but missed the case where a dev-only direct parent is already at its latest published version while still carrying vulnerable transitive deps (e.g., `@lhci/cli@0.15.1` with `minimatch@3.1.2`). This is a real, untestable gap — the implementer upgrades everything and still can't resolve the advisory. Audit policies for upgrade issues must include an explicit "latest-parent-but-still-vulnerable" rule that defines what to do (accept with documentation, replace the package, or file upstream).
