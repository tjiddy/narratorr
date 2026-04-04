---
scope: [backend]
files: [src/server/services/library-scan.service.test.ts]
issue: 341
date: 2026-04-04
---
Adding a new fire-and-forget event before an existing event (e.g., book_added before imported) shifts `mock.calls` indices. Tests that access `mock.calls[0]` by index instead of filtering by `eventType` break silently. Fix: always filter mock calls by event type instead of relying on call order — use `.find(c => c.eventType === 'imported')` instead of `[0]`.
