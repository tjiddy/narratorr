---
scope: [frontend]
files: [src/client/pages/library/helpers.ts]
issue: 266
date: 2026-04-01
---
`BookWithAuthor.seriesPosition` can be `undefined` (not just `null`) because it comes from the API response type, but `compareNullable` only accepts `string | number | null`. Always coalesce with `?? null` when passing optional DB fields to comparison helpers. This caused a typecheck failure that wasn't caught by tests (both `undefined` and `null` behave the same at runtime in JS comparisons).
