---
scope: [scope/backend]
files: [src/core/notifiers/types.ts]
issue: 279
source: spec-review
date: 2026-03-10
---
Spec didn't specify whether health notifications fire per-check or per-run when multiple checks change simultaneously. The existing payload shape (`checkName` singular) implies per-check, but leaving this ambiguous allows either implementation. Notification granularity must be explicit in specs — it affects both spam behavior and test assertions.
