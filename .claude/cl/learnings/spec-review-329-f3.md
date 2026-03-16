---
scope: [type/chore, scope/infra]
files: [package.json]
issue: 329
source: spec-review
date: 2026-03-11
---
The audit AC said "zero high/critical, moderate acceptable only if no fix available" but didn't distinguish runtime vs dev-only deps, or `update` vs `review` audit actions. This makes the pass/fail condition unimplementable. For audit-driven issues, always include a disposition policy that classifies findings by runtime/dev-only and update/review action type.
