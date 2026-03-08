---
scope: [scope/backend]
files: [src/server/jobs/monitor.ts, src/server/jobs/monitor.test.ts]
issue: 270
source: review
date: 2026-03-08
---
Monitor tests for handleDownloadFailure asserted `db.update` was called but didn't verify the specific errorMessage values being set. This is a pattern gap: when a function sets distinct persisted values per branch (e.g., "Retries exhausted" vs "No viable candidates" vs "Retry failed"), tests must assert the exact value, not just that the update happened. Use `chain.set` mock call inspection to verify the actual payload.
