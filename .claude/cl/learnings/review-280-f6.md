---
scope: [scope/frontend]
files: [src/client/pages/settings/SystemSettings.tsx]
issue: 280
source: review
date: 2026-03-10
---
The create backup mutation's onSuccess/onError handlers (toast notifications, query invalidation) were never asserted in tests. Prevention: mutation side effects (toasts, cache invalidation) should have explicit test assertions, not just the happy-path trigger.
