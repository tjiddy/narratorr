---
scope: [infra]
files: [scripts/claim.ts, scripts/resume.ts]
issue: 353
source: spec-review
date: 2026-03-14
---
Spec proposed adding branch recovery to claim.ts without defining how it coexists with existing status guards and the /resume workflow. When modifying a script that participates in a multi-script lifecycle (claim → implement → handoff, resume → implement), the spec must define interaction policy — which guards are preserved, which responsibilities shift, and which stay with the existing owner.
