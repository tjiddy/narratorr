---
scope: [frontend]
files: [src/client/components/settings/IndexerFields.test.tsx]
issue: 361
source: review
date: 2026-04-05
---
Negative-only assertions (expect.not.objectContaining) are insufficient for branch-specific behavior. When testing that a non-sentinel refresh resends the entered mamId, asserting `id` is absent doesn't prove the correct mamId was sent. Always pair negative assertions with positive ones that pin the expected value.
