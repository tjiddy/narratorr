---
scope: [backend, services]
files: [src/server/services/quality-gate.service.ts]
issue: 39
date: 2026-03-20
---
When adding a bypass branch to a decision tree, position it before ALL comparison branches it is meant to skip — not after them. The first-download exemption (`book.path === null → imported`) was initially placed after the quality comparison branches. A placeholder book with metadata-populated `size`/`duration` fields would have non-null `existingMbPerHour`, causing the quality comparison to fire and either reject or import based on stale metadata quality — ignoring the bypass entirely. Moving the exemption to position 2 (right after holdReasons check) fixed this. Rule: "bypass before the code it bypasses."
