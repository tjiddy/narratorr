---
scope: [frontend]
files: [src/client/pages/book/BookDetails.test.tsx]
issue: 238
source: review
date: 2026-03-31
---
Navigation side effects in mutation `onSuccess` callbacks need explicit test assertions. The `navigate('/library')` call in BookDetails was inside a per-call `onSuccess` override, making it invisible to the hook-level tests. When a mutation has a side effect beyond API calls and toasts (redirect, modal close, form reset), add a dedicated test that asserts the specific side effect.
