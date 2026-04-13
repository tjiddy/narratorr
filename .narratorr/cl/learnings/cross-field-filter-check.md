---
scope: [backend]
files: [src/server/services/search-pipeline.ts]
issue: 541
date: 2026-04-13
---
When a filter checks one string for two opposite signals (ebook vs audio keywords), the precedence chain (`nzbName || rawTitle || title`) can hide the second signal if it lives in a different field. The fix: use the precedence chain for the primary signal (ebook detection) but check all fields independently for the counter-signal (audio detection). Other filters in `filterAndRankResults` (reject/required words, multipart) still use single-precedence correctly because they only look for one signal.
