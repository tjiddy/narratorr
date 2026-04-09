---
scope: [backend]
files: [src/server/jobs/search.test.ts]
issue: 439
source: review
date: 2026-04-09
---
When fixing caller-matrix test gaps across multiple callers, enumerate ALL callers exhaustively before committing. The round-1 fix covered 6 of 7 callers but missed `runUpgradeSearchJob()`, causing a round-2 finding. A simple checklist of the issue's caller matrix against the added test describes would have caught this.