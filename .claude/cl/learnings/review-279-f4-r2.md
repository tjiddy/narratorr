---
scope: [frontend]
files: [src/client/pages/settings/HealthDashboard.test.tsx]
issue: 279
source: review
date: 2026-03-10
---
Mutation onSuccess handlers that invalidate multiple query keys need tests proving BOTH keys are invalidated. Testing only that the mutation was called doesn't prove the cache invalidation side effects. Pattern: render a companion component that subscribes to the second query key, then assert both query functions are re-called after the mutation succeeds.
