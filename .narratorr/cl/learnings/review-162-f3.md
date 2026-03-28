---
scope: [scope/frontend, scope/ui]
files: [src/client/components/ConfirmModal.tsx, src/client/components/ConfirmModal.test.tsx]
issue: 162
source: review
date: 2026-03-28
---
When migrating callers to use Button with a specific variant (especially destructive), the test for that caller must assert the variant classes on the rendered button. Functional tests (clicks callbacks, renders text) do not cover visual correctness of the variant wiring. For destructive actions this matters — a regression to secondary/ghost would silently pass functional tests.
