---
scope: [core]
files: [src/shared/schemas/settings/library.ts]
issue: 228
source: review
date: 2026-03-30
---
Reviewer caught that `hasTitle()`/`hasAuthor()` used independent regex heuristics instead of the same `disambiguateTokenMatch()` logic as `parseTemplate()`/`validateTokens()`. This meant `{author?title}` (suffix syntax where "title" is just text) would falsely satisfy `hasTitle()`. Prevention: when adding disambiguation logic, ensure ALL consumers that match tokens use the same disambiguation path — grep for the old pattern across the codebase.
