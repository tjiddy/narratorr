---
scope: [scope/frontend]
files: []
issue: 367
source: spec-review
date: 2026-03-16
---
Spec referenced backend API routes (`/api/discover/*`) as if they existed, but the dependency issue (#366) hadn't landed. The reviewer flagged that AC items were untestable because the named contracts weren't on `main`. When a frontend spec depends on a backend issue that hasn't merged, the spec must either: (a) explicitly gate claiming on the dependency, or (b) pin the exact expected API contract so the spec is self-contained and verifiable against the contract, not the codebase.
