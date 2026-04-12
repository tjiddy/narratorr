---
scope: [backend, core]
files: [src/core/metadata/audible.ts]
issue: 497
date: 2026-04-12
---
Audible adapter's `searchBooks` param logic uses `if (options?.title)` as the gate for structured search, meaning `options.author` without `title` silently falls through to `keywords=`. When adding new param combinations, check the branching order — the most specific condition (`title+author`) must come first, then `author`-only, then `keywords` fallback.
