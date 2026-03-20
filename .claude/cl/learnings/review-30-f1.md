---
scope: [backend]
files: [src/server/services/search-pipeline.ts]
issue: 30
source: review
date: 2026-03-20
---
JavaScript `\b` word boundaries treat underscore as a word character (since `\w = [a-zA-Z0-9_]`), so `\bepub\b` does NOT match `Dune_EPUB`. Scene-style release names use underscores as separators — a regex-based keyword filter that uses `\b` will silently miss them. Fix: use `(?<![a-zA-Z\d])` and `(?![a-zA-Z\d])` instead of `\b` to treat underscores as non-word separators. Prevented by: always testing underscore-separated variants when writing title-keyword regex tests.
