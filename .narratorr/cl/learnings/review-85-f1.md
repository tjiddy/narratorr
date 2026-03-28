---
scope: [backend]
files: [src/server/services/recycling-bin.service.test.ts]
issue: 85
source: review
date: 2026-03-25
---
The spec said "comma-in-name author round-trip test" but the implementation only added the snapshot half (moveToRecycleBin stores the array) and missed the restore half (restore passes the name intact to syncAuthors). A "round-trip" AC always implies two assertions: the write/store side AND the read/restore side. When a spec says "round-trip," write tests for both ends before closing the issue — the narrator version (Smith, John) already covered the restore side, but that was missed as a model to duplicate for the author case.
