---
scope: [scope/backend, scope/services]
files: []
issue: 422
source: spec-review
date: 2026-03-17
---
AC1 set a "under 400 lines" target but only named one extraction seam (SSE helper), making the target seem unjustified. Root cause: didn't verify the ESLint counting mode (skipBlankLines+skipComments reduces 585 total to 438 counted) or do the math on how many lines each extraction saves. Fix: when an AC has a numeric threshold, show the arithmetic — current count, what each change saves, projected result.
