---
scope: [backend]
files: [src/server/services/match-job.service.ts]
issue: 415
source: review
date: 2026-04-08
---
When refactoring a function's return type from `T | null` to a structured result that always returns, update all callers' conditional logic to match. The debug log at line 233 still used a truthiness check on the old return pattern (`reason ? 'Duration-informed' : 'no duration'`), which mislabeled two of three medium-confidence branches. Fix: use the actual reason string as the log message instead of a generic label.
