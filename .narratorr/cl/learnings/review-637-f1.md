---
scope: [backend, services]
files: [src/server/services/import-orchestration.helpers.ts]
issue: 637
source: review
date: 2026-04-18
---
`pipeline(createReadStream, createWriteStream)` only resolves when the entire file is copied — for per-chunk progress on large files, insert a `Transform` stream that tracks `chunk.length` in its `transform()` callback. Without this, single-file audiobooks show 0→100% with no intermediate progress.
