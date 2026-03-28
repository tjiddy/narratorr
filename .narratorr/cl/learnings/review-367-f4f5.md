---
scope: [scope/frontend]
files: [src/client/pages/discover/DiscoverPage.tsx, src/client/pages/discover/DiscoverPage.test.tsx]
issue: 367
source: review
date: 2026-03-16
---
Add and dismiss mutation tests only asserted the API call and error toast, not the optimistic UI behavior (card disappears immediately, reappears on failure) or success consequences (success toast). This meant deleting optimistic removal/restore logic would leave tests green. Prevention: when testing mutations with optimistic UI, use deferred promises to test the intermediate state (card hidden while pending) and verify restoration on rejection. Always test both success and failure consequences, not just invocation.
