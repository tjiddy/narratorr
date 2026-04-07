---
scope: [backend, services]
files: [src/server/utils/import-helpers.ts]
issue: 397
date: 2026-04-07
---
When generating sequential filenames (`1.mp3`, `2.mp3`, ...) for multi-disc files and also including non-disc files with their original names, the non-disc filenames can collide with the sequential names (e.g., `Extras/1.mp3` vs disc sequential `1.mp3`). Self-review caught this before handoff. Always add collision detection when mixing generated and original filenames in the same output set.
