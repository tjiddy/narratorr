---
scope: [scope/frontend]
files: [src/client/components/AuthProvider.tsx, src/client/components/AuthProvider.test.tsx]
issue: 365
source: spec-review
date: 2026-03-15
---
Spec review caught that L-35 ("AuthProvider redirect logic is dead code") is wrong — the redirect is active and tested. `AuthProvider.tsx:20-21` redirects unauthenticated forms-mode users to `/login`, and `AuthProvider.test.tsx:45-54` asserts this behavior.

Root cause: `/elaborate` trusted the debt scan finding label "dead code" without reading `AuthProvider.tsx` or its test file. A simple read would have shown the redirect is active.

Prevention: When a debt scan flags code as "dead", always read the source file and its test file before including it as an actionable AC item. "Dead code" claims require verification, not trust.
