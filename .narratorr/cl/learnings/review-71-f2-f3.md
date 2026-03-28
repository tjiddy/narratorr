---
scope: [backend, services]
files: [src/server/services/recycling-bin.service.ts, src/server/services/recycling-bin.service.test.ts]
issue: 71
source: review
date: 2026-03-24
---
Recycling bin snapshots must use the issue-specified delimiter contract consistently across snapshot and restore. F2: `authorName` must store comma-joined names for all authors (not just `authors[0].name`), and restore must split by `, ` to find-or-create each author. F3: narrator snapshot must use `, ` delimiter (not `; `) matching the issue spec — restore split logic must match the snapshot join. Tests that assert snapshot content must match the actual delimiter exactly, or they lock in the wrong contract. When specifying a delimiter in an issue spec, grep the codebase for all usages of the old/wrong delimiter to ensure full consistency.
