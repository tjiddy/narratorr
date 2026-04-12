---
scope: [backend]
files: [src/server/services/search-pipeline.ts]
issue: 503
date: 2026-04-12
---
ESLint `max-lines` counts non-blank, non-comment lines — a file at 495 total lines may be at exactly 400 code lines. Adding even a few lines of logic can trip the rule. When working in files near the limit, compact new code (single-line conditionals, multi-param-per-line function calls) proactively rather than discovering the violation after verify.
