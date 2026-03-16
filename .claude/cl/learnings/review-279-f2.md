---
scope: [backend]
files: [src/server/services/task-registry.ts]
issue: 279
source: review
date: 2026-03-10
---
estimateNextRun() checked `parts.length >= 5` before `parts.length === 6`, so 6-part second-based cron expressions (*/30 * * * * *) were misclassified as minute-based. Fix: check 6-part BEFORE 5-part. When parsing expressions with variable-length syntax, always check the most specific format first.
