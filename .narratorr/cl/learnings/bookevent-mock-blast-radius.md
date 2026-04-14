---
scope: [frontend]
files: [src/client/lib/api/event-history.ts, src/client/components/EventHistoryCard.test.tsx, src/client/hooks/useEventHistory.test.ts, src/client/pages/activity/EventHistorySection.test.tsx, src/client/pages/book/BookEventHistory.test.tsx]
issue: 547
date: 2026-04-14
---
Adding a required field to a client-side interface (`BookEvent`) causes TypeScript errors in every test file with inline mock objects — 4 files and 8+ fixture sites for BookEvent alone. The `createMockEvent` factory in EventHistoryCard.test.tsx handled it gracefully via spread, but inline mocks in other test files each needed manual `narratorName: null` additions. Using factory functions with `Partial<T>` overrides (like `createMockEvent`) is more resilient to interface changes than inline object literals.
