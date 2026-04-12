---
scope: [backend, core]
files: [src/server/services/search-pipeline.ts]
issue: 502
date: 2026-04-12
---
JavaScript does not allow mixing `??` and `||` without explicit parentheses — `(a || b ?? c)` is a syntax error caught by esbuild at build time (not TypeScript). When building a 3-tier fallback chain where empty strings should be treated as absent (falsy), use `||` throughout: `(a || b || c)` rather than mixing operators. This caused a build failure that was caught only when running the test file, not during typecheck.
