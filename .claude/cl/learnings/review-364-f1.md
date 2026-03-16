---
scope: [frontend]
files: [src/client/lib/stableKeys.ts]
issue: 364
source: review
date: 2026-03-14
---
Stable React key functions should NOT include array index unconditionally — that makes every key order-dependent, which is the exact problem unstable keys cause. Index should only be appended when two items produce the same key from their stable fields (true duplicates). The correct pattern: key functions return purely field-based keys, and a separate deduplicateKeys helper adds suffixes only where collisions actually occur.
