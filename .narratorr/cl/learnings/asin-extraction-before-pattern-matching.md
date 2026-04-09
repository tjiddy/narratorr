---
scope: [backend, core]
files: [src/server/utils/folder-parsing.ts]
issue: 454
date: 2026-04-09
---
ASIN extraction must run before ALL other pattern matching in folder parsing — not just before `parenMatch` but before the series-number-title and dash patterns too. The `extractASIN` helper strips the bracket from the input string before any regex is applied, preventing ASIN content from being misinterpreted as author names, series markers, or title segments.
