---
scope: [backend, db]
files: [src/server/services/recycling-bin.service.test.ts]
issue: 214
source: review
date: 2026-03-30
---
Transaction rollback tests that only assert "error thrown" and "transaction called" are insufficient when there are irreversible side effects outside the transaction boundary. Tests must also assert the post-failure state: were compensating actions taken? Is the system in a retryable state? For filesystem + DB operations, assert that the filesystem was restored to its pre-operation state (e.g., files moved back).
