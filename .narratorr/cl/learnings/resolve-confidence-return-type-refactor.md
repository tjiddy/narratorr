---
scope: [backend]
files: [src/server/services/match-job.service.ts]
issue: 415
date: 2026-04-08
---
When adding a reason/detail field alongside a confidence result, refactor the helper function to always return a structured result (never null) so the caller doesn't need ternary fallback logic. This prevents cyclomatic complexity violations — the original `null`-returning design required the caller to compute a default reason, adding 3 branches that pushed `matchSingleBook` past the ESLint complexity limit of 15.
