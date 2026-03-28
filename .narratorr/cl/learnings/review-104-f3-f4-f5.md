---
scope: [backend, services]
files: [src/server/services/library-scan.service.test.ts]
issue: 104
source: review
date: 2026-03-25
---
Fire-and-forget event recording needs three test variants per site: (1) success path event rejects — method still resolves; (2) failure path: both primary failure and event creation reject — method still throws original error; (3) background path: event create rejects on failure — status update still completes. Only testing the happy path (event succeeds) leaves critical isolation gaps. Every .catch() handler needs a corresponding test that exercises it.
